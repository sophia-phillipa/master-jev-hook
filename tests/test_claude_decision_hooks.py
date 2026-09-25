"""Decision hooks of claude_jev.py: local filters, gateway request shape, fail-open and limits."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]


class FakeGateway:
    """Records POST bodies and answers each with the next queued (status, json) pair."""

    def __init__(self):
        self.requests, self.replies = [], []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["content-length"]))
                outer.requests.append((self.path, json.loads(body)))
                status, reply = outer.replies.pop(0) if outer.replies else (200, {"status": "fallback"})
                raw = json.dumps(reply).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def choice(qid, value, confidence=0.9, status="ok"):
    return {"status": status, "answers": {qid: {"type": "choice", "status": status,
                                                "choice": value, "confidence": confidence}}}


class DecisionHookTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)
        self.gateway = FakeGateway()
        self.addCleanup(self.gateway.close)
        self.helper = self.dir / "claude_jev.py"
        shutil.copy(ROOT / "claude_jev.py", self.helper)
        shutil.copy(ROOT / "master-jev-hook-claude.md", self.dir / "master-jev-hook-claude.md")
        self.configure(self.gateway.url)

    def configure(self, url):
        (self.dir / "claude_jev.json").write_text(json.dumps({"gateway_url": url}))

    def run_hook(self, mode, event, timeout=15):
        result = subprocess.run([sys.executable, str(self.helper), mode], input=json.dumps(event),
                                text=True, capture_output=True, timeout=timeout)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout) if result.stdout.strip() else None

    def transcript(self, entries):
        path = self.dir / "transcript.jsonl"
        path.write_text("".join(json.dumps(e) + "\n" for e in entries))
        return str(path)

    # --- Bash gate -------------------------------------------------------------------------------
    def bash(self, command):
        return {"hook_event_name": "PreToolUse", "tool_name": "Bash", "session_id": "s1", "cwd": "/w",
                "tool_input": {"command": command, "description": "d"}}

    def test_bash_gate_skips_routine_commands_without_consulting(self):
        for command in ("ls -la", "git status", "pytest -q", "cat README.md | head", "rmdir empty"):
            self.assertIsNone(self.run_hook("bash-gate", self.bash(command)), command)
        self.assertEqual(self.gateway.requests, [])

    def test_bash_gate_asks_when_jev_flags_risk(self):
        self.gateway.replies.append((200, choice("risk", "destructive", 0.93)))
        out = self.run_hook("bash-gate", self.bash("rm -rf build/ && git push --force origin main"))
        path, body = self.gateway.requests[0]
        self.assertEqual(path, "/master/decide")
        self.assertEqual(set(body), {"state", "questions"})
        self.assertEqual(body["state"]["command"], "rm -rf build/ && git push --force origin main")
        self.assertEqual(body["questions"]["risk"]["type"], "choice")
        self.assertEqual(set(body["questions"]["risk"]["criteria"]), {"routine", "confirm", "destructive"})
        decision = out["hookSpecificOutput"]
        self.assertEqual(decision["permissionDecision"], "ask")
        self.assertIn("destructive", decision["permissionDecisionReason"])
        self.assertIn("🔷", out["systemMessage"])

    def test_bash_gate_routine_verdict_and_low_confidence_only_inform(self):
        self.gateway.replies.append((200, choice("risk", "routine", 0.88)))
        out = self.run_hook("bash-gate", self.bash("rm -rf node_modules"))
        self.assertNotIn("hookSpecificOutput", out)
        self.assertIn("routine", out["systemMessage"])
        self.gateway.replies.append((200, choice("risk", None, 0.4, status="abstain")))
        out = self.run_hook("bash-gate", self.bash("sudo rm -rf /opt/x"))
        self.assertNotIn("hookSpecificOutput", out)
        self.assertIn("no decision", out["systemMessage"])

    def test_bash_gate_fails_open_on_error_and_unreachable_gateway(self):
        self.gateway.replies.append((400, {"status": "fallback", "reason": "invalid_workflow"}))
        out = self.run_hook("bash-gate", self.bash("git reset --hard HEAD~3"))
        self.assertNotIn("hookSpecificOutput", out)
        self.assertIn("invalid_workflow", out["systemMessage"])
        self.configure("http://127.0.0.1:9")
        out = self.run_hook("bash-gate", self.bash("git reset --hard HEAD~3"))
        self.assertNotIn("hookSpecificOutput", out or {})

    # --- Stop check --------------------------------------------------------------------------------
    def turn(self, *tools, prompt="Fix the bug"):
        entries = [{"type": "user", "message": {"role": "user", "content": prompt}}]
        for name, tool_input in tools:
            entries.append({"type": "assistant", "message": {"role": "assistant", "content": [
                {"type": "tool_use", "id": "t", "name": name, "input": tool_input}]}})
        return self.transcript(entries)

    def stop(self, transcript, active=False, session="s1"):
        return {"hook_event_name": "Stop", "session_id": session, "stop_hook_active": active,
                "transcript_path": transcript, "last_assistant_message": "Done, I fixed the bug."}

    def test_stop_check_consults_only_after_unverified_edits(self):
        self.assertIsNone(self.run_hook("stop-check", self.stop(self.turn(("Read", {"file_path": "a"})))))
        verified = self.turn(("Edit", {"file_path": "a.py"}), ("Bash", {"command": "python -m pytest -q"}))
        self.assertIsNone(self.run_hook("stop-check", self.stop(verified)))
        edited = self.turn(("Edit", {"file_path": "a.py"}))
        self.assertIsNone(self.run_hook("stop-check", self.stop(edited, active=True)))
        self.assertEqual(self.gateway.requests, [])

    def test_stop_check_gives_feedback_at_most_three_times(self):
        edited = self.turn(("Edit", {"file_path": "a.py"}), ("Bash", {"command": "ls"}))
        for _ in range(4):
            self.gateway.replies.append((200, choice("completion", "done_unverified", 0.9)))
        outputs = [self.run_hook("stop-check", self.stop(edited)) for _ in range(4)]
        _, body = self.gateway.requests[0]
        self.assertEqual(body["state"]["edited_files"], ["a.py"])
        self.assertIn("done_unverified", body["questions"]["completion"]["criteria"])
        for out in outputs[:3]:
            self.assertIn("verif", out["hookSpecificOutput"]["additionalContext"])
            self.assertNotIn("decision", out)
        self.assertIsNone(outputs[3])
        self.assertEqual(len(self.gateway.requests), 3)

    def test_stop_check_accepts_verified_verdict(self):
        self.gateway.replies.append((200, choice("completion", "done_verified", 0.9)))
        out = self.run_hook("stop-check", self.stop(self.turn(("Write", {"file_path": "b.md"}))))
        self.assertNotIn("hookSpecificOutput", out)
        self.assertIn("🔷", out["systemMessage"])

    # --- Compaction ----------------------------------------------------------------------------
    def test_precompact_selects_items_and_session_start_reinjects_them(self):
        prompts = ["Talk to me in English", "ok", "Don't push without asking me", "read the README"]
        transcript = self.transcript([{"type": "user", "message": {"role": "user", "content": p}} for p in prompts])
        self.gateway.replies.append((200, {"status": "ok", "answers": {
            "u0": {"type": "noul", "status": "ok", "noul": 0.92},
            "u1": {"type": "noul", "status": "ok", "noul": 0.81},
            "u2": {"type": "noul", "status": "ok", "noul": 0.1}}}))
        out = self.run_hook("precompact", {"hook_event_name": "PreCompact", "session_id": "s9",
                                           "transcript_path": transcript, "trigger": "auto"})
        self.assertIsNone(out)
        _, body = self.gateway.requests[0]
        self.assertEqual([body["state"]["items"][k] for k in ("u0", "u1", "u2")],
                         ["Talk to me in English", "Don't push without asking me", "read the README"])
        self.assertTrue(all(q["type"] == "noul" for q in body["questions"].values()))
        start = self.run_hook("hook", {"hook_event_name": "SessionStart", "source": "compact", "session_id": "s9"})
        context = start["hookSpecificOutput"]["additionalContext"]
        self.assertIn("Talk to me in English", context)
        self.assertIn("Don't push without asking me", context)
        self.assertNotIn("read the README", context)
        self.assertIn("request_decision", context)
        other = self.run_hook("hook", {"hook_event_name": "SessionStart", "source": "startup", "session_id": "s9"})
        self.assertNotIn("Talk to me", other["hookSpecificOutput"]["additionalContext"])

    def test_precompact_failure_never_blocks(self):
        self.configure("http://127.0.0.1:9")
        transcript = self.transcript([{"type": "user", "message": {"role": "user", "content": "Long rule x"}}])
        self.assertIsNone(self.run_hook("precompact", {"hook_event_name": "PreCompact", "session_id": "s8",
                                                        "transcript_path": transcript, "trigger": "manual"}))

    # --- Drift detector ----------------------------------------------------------------------------
    def test_drift_consults_every_fifteen_tool_calls(self):
        transcript = self.turn(*[("Read", {"file_path": f"f{i}"}) for i in range(15)])
        event = {"hook_event_name": "PostToolUse", "tool_name": "Read", "session_id": "s2",
                 "transcript_path": transcript, "tool_input": {}}
        self.gateway.replies.append((200, choice("direction", "stuck", 0.8)))
        outputs = [self.run_hook("drift", event) for _ in range(15)]
        self.assertTrue(all(out is None for out in outputs[:14]))
        self.assertEqual(len(self.gateway.requests), 1)
        _, body = self.gateway.requests[0]
        self.assertEqual(body["state"]["request"], "Fix the bug")
        self.assertEqual(len(body["state"]["recent_actions"]), 15)
        self.assertIn("stuck", outputs[14]["hookSpecificOutput"]["additionalContext"])
        self.gateway.replies.append((200, choice("direction", "on_track", 0.9)))
        outputs = [self.run_hook("drift", event) for _ in range(15)]
        self.assertNotIn("hookSpecificOutput", outputs[14])
        self.assertIn("on_track", outputs[14]["systemMessage"])


if __name__ == "__main__":
    unittest.main()
