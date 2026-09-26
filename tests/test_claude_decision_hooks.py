"""Decision hooks of claude_jev.py: local filters, gateway request shape, fail-open and limits."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
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
    def bash(self, command, transcript=None):
        return {"hook_event_name": "PreToolUse", "tool_name": "Bash", "session_id": "s1", "cwd": "/w",
                "transcript_path": transcript, "tool_input": {"command": command, "description": "d"}}

    def conversation(self, *prompts):
        """A transcript with the user's prompts, plus meta and tool-result rows the gate must ignore."""
        rows = []
        for prompt in prompts:
            rows.append({"type": "user", "message": {"role": "user", "content": prompt}})
            rows.append({"type": "user", "isMeta": True, "message": {"role": "user", "content": "meta note"}})
            rows.append({"type": "user", "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t", "content": "tool output"}]}})
        return self.transcript(rows)

    def test_bash_gate_skips_routine_commands_without_consulting(self):
        for command in ("ls -la", "git status", "pytest -q", "cat README.md | head", "rmdir empty"):
            self.assertIsNone(self.run_hook("bash-gate", self.bash(command)), command)
        self.assertEqual(self.gateway.requests, [])

    def test_risky_filter_sees_git_global_options(self):
        sys.path.insert(0, str(self.dir))
        self.addCleanup(sys.path.remove, str(self.dir))
        import claude_jev
        for command in ("git -C /tmp/r reset --hard HEAD~1", 'git -C "/my repo" push --force origin main',
                        "git --no-pager -c color.ui=never push origin main", "git --git-dir=/r/.git --work-tree=/r clean -fdx",
                        "git --git-dir /r/.git reset --hard"):
            self.assertTrue(claude_jev.RISKY_BASH.search(command), command)
        for command in ("git -C /tmp/r status", "git -c core.pager=cat log -p -1", "git --no-pager diff"):
            self.assertFalse(claude_jev.RISKY_BASH.search(command), command)

    def test_bash_gate_asks_when_jev_flags_risk(self):
        self.gateway.replies.append((200, choice("risk", "confirm", 0.93)))
        transcript = self.conversation("first", "second", "third", "Clean the build output, token=abc123")
        out = self.run_hook("bash-gate", self.bash("rm -rf build/ && git push --force origin main", transcript))
        path, body = self.gateway.requests[0]
        self.assertEqual(path, "/master/decide")
        self.assertEqual(set(body), {"state", "questions", "risk"})
        self.assertEqual(body["risk"], "medium")
        self.assertEqual(body["state"]["command"], "rm -rf build/ && git push --force origin main")
        # Last three user prompts, most recent last, redacted; meta and tool results ignored.
        self.assertEqual(body["state"]["request"], ["second", "third", "Clean the build output, token=[REDACTED]"])
        self.assertEqual(body["questions"]["risk"]["type"], "choice")
        self.assertEqual(set(body["questions"]["risk"]["criteria"]), {"routine", "confirm"})
        decision = out["hookSpecificOutput"]
        self.assertEqual(decision["permissionDecision"], "ask")
        self.assertIn("confirm", decision["permissionDecisionReason"])
        self.assertIn("🔷", out["systemMessage"])

    def test_bash_gate_sends_an_empty_request_without_a_transcript(self):
        for transcript in (None, str(self.dir / "missing.jsonl")):
            self.gateway.replies.append((200, choice("risk", "routine", 0.9)))
            self.run_hook("bash-gate", self.bash("rm -rf dist", transcript))
            self.assertEqual(self.gateway.requests[-1][1]["state"]["request"], [])
        long = self.conversation("x" * 2000)
        self.gateway.replies.append((200, choice("risk", "routine", 0.9)))
        self.run_hook("bash-gate", self.bash("rm -rf dist", long))
        self.assertEqual(len(self.gateway.requests[-1][1]["state"]["request"][0]), 700)

    SELF_DISABLE_COMMANDS = ("systemctl --user disable --now master-jev-hook", "systemctl --user stop master-jev-hook.service",
                             "systemctl --user --now disable master-jev-hook", "systemctl -q --user stop master-jev-hook.service")

    def test_bash_gate_lets_the_gateway_turn_off_when_the_request_requires_it(self):
        transcript = self.conversation("Uninstall the Master-JEV Hook gateway")
        for command in self.SELF_DISABLE_COMMANDS:
            self.gateway.replies.append((200, choice("off", "required", 0.95)))
            out = self.run_hook("bash-gate", self.bash(command, transcript))
            self.assertNotIn("hookSpecificOutput", out, command)  # never grants permission: normal flow applies
            self.assertIn("required", out["systemMessage"])
        _, body = self.gateway.requests[0]
        self.assertEqual(body["risk"], "medium")
        self.assertEqual(set(body["questions"]), {"off"})
        self.assertEqual(set(body["questions"]["off"]["criteria"]), {"required", "not_required"})
        self.assertEqual(body["state"]["request"], ["Uninstall the Master-JEV Hook gateway"])
        self.assertNotIn("cwd", body["state"])
        self.assertEqual(len(self.gateway.requests), len(self.SELF_DISABLE_COMMANDS))

    def test_bash_gate_denies_turning_off_the_gateway_when_not_required_or_unsure(self):
        transcript = self.conversation("Fix the failing test")
        for reply in (choice("off", "not_required", 0.9), choice("off", None, 0.5, status="abstain")):
            for command in self.SELF_DISABLE_COMMANDS:  # option-before-verb variants route here too
                self.gateway.replies.append((200, reply))
                out = self.run_hook("bash-gate", self.bash(command, transcript))
                decision = out["hookSpecificOutput"]
                self.assertEqual(decision["permissionDecision"], "deny", command)
                self.assertIn("not required", decision["permissionDecisionReason"])
                self.assertIn("systemctl --user restart master-jev-hook", decision["permissionDecisionReason"])
        self.assertTrue(all(set(body["questions"]) == {"off"} for _, body in self.gateway.requests))

    def test_bash_gate_fails_open_on_turning_off_when_the_gateway_is_down(self):
        self.gateway.replies.append((400, {"status": "fallback", "reason": "invalid_workflow"}))
        out = self.run_hook("bash-gate", self.bash("systemctl --user stop master-jev-hook"))
        self.assertNotIn("hookSpecificOutput", out)
        self.configure("http://127.0.0.1:9")
        out = self.run_hook("bash-gate", self.bash("systemctl --user stop master-jev-hook"))
        self.assertNotIn("hookSpecificOutput", out)
        self.assertIn("no decision", out["systemMessage"])

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

    # --- Session-start self-test -----------------------------------------------------------------
    def probe_reply(self, choice="true", score=1.9, noul=0.95):
        return {"status": "ok", "calls": 1, "latencyMs": 280, "inputTokens": 470, "outputTokens": 70, "answers": {
            "choice": {"type": "choice", "status": "ok", "choice": choice, "confidence": 0.96},
            "score": {"type": "score", "status": "ok", "score": score, "confidence": 0.82},
            "noul": {"type": "noul", "status": "ok", "noul": noul}}}

    def test_session_start_reports_active_only_after_correct_answers(self):
        self.gateway.replies.append((200, self.probe_reply()))
        out = self.run_hook("hook", {"hook_event_name": "SessionStart", "source": "startup", "session_id": "p1"})
        path, body = self.gateway.requests[0]
        self.assertEqual(path, "/master/decide")
        self.assertEqual(body["risk"], "low")
        self.assertEqual({q["type"] for q in body["questions"].values()}, {"choice", "score", "noul"})
        message = out["systemMessage"]
        self.assertEqual(message, "🔷 Master-JEV Hook gateway active: live JEV test passed (1 paid call, 280 ms, 540 tokens):\n\n"
                                  "* Choice: picks one option ✅\n* Score: rates on a scale ✅\n* Noul: probability of yes ✅")
        context = out["hookSpecificOutput"]["additionalContext"]
        self.assertIn("print the block below verbatim", context)
        self.assertTrue(context.endswith(message))

    def test_session_start_flags_wrong_or_missing_answers(self):
        reply = self.probe_reply(choice="false")
        reply["answers"]["noul"] = {"type": "noul", "status": "abstain"}
        self.gateway.replies.append((200, reply))
        message = self.run_hook("hook", {"hook_event_name": "SessionStart", "source": "startup"})["systemMessage"]
        self.assertTrue(message.startswith("⚠️ Master-JEV Hook gateway reachable, but the live JEV test passed 1/3"))
        self.assertNotIn("gateway active", message)
        self.assertIn("* Choice: picks one option ⚠️", message)
        self.assertIn("* Score: rates on a scale ✅", message)
        self.assertIn("* Noul: probability of yes ❌ (no decision (abstain))", message)
        self.assertNotIn("Water boils", message)  # the question and the answers are not shown
        self.assertNotIn("0.96", message)

    def test_session_start_reports_skipped_and_unreachable_gateway(self):
        self.gateway.replies.append((200, {"status": "skipped", "reason": "routing_disabled"}))
        message = self.run_hook("hook", {"hook_event_name": "SessionStart", "source": "startup"})["systemMessage"]
        self.assertIn("passed 0/3 (no JEV call made: routing_disabled)", message)
        self.configure("http://127.0.0.1:9")
        message = self.run_hook("hook", {"hook_event_name": "SessionStart", "source": "startup"})["systemMessage"]
        self.assertEqual(message, "❌ Master-JEV Hook gateway unreachable at http://127.0.0.1:9; "
                                  "JEV decisions fall back to local alternatives.")

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
        self.assertNotIn("risk", body)  # default low threshold: the instructions, not a higher bar, avoid false alarms
        self.assertIn("stuck", outputs[14]["hookSpecificOutput"]["additionalContext"])
        self.gateway.replies.append((200, choice("direction", "on_track", 0.9)))
        outputs = [self.run_hook("drift", event) for _ in range(15)]
        self.assertNotIn("hookSpecificOutput", outputs[14])
        self.assertIn("on_track", outputs[14]["systemMessage"])

    # --- Redaction ---------------------------------------------------------------------------------
    def test_bash_gate_redacts_credentials_in_the_command(self):
        self.gateway.replies.append((200, choice("risk", "confirm", 0.9)))
        self.run_hook("bash-gate", self.bash("git push https://user:ghp_SECRETTOKEN123@github.com/o/r.git main"))
        _, body = self.gateway.requests[0]
        self.assertEqual(body["state"]["command"], "git push https://[REDACTED]@github.com/o/r.git main")
        self.assertNotIn("SECRETTOKEN", json.dumps(body))

    def test_drift_sends_only_tool_names_and_targets(self):
        secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"
        transcript = self.turn(("Write", {"file_path": "/w/.env", "content": f"OPENAI_API_KEY={secret}\n"}),
                               ("Edit", {"file_path": "/w/a.py", "old_string": "x = 1", "new_string": "password = 'hunter2'"}),
                               ("Bash", {"command": "curl -H 'Authorization: Bearer abc123' https://api.test"}),
                               *[("Read", {"file_path": f"f{i}"}) for i in range(12)],
                               prompt="Wire the key OPENAI_API_KEY=" + secret + " into the app")
        event = {"hook_event_name": "PostToolUse", "tool_name": "Read", "session_id": "s3",
                 "transcript_path": transcript, "tool_input": {}}
        self.gateway.replies.append((200, choice("direction", "on_track", 0.9)))
        for _ in range(15):
            self.run_hook("drift", event)
        _, body = self.gateway.requests[0]
        actions = body["state"]["recent_actions"]
        self.assertEqual(actions[:2], ["Write /w/.env", "Edit /w/a.py"])
        self.assertIn("Bearer [REDACTED]", actions[2])
        sent = json.dumps(body)
        for leaked in (secret, "hunter2", "abc123", "x = 1"):
            self.assertNotIn(leaked, sent)
        self.assertIn("OPENAI_API_KEY=[REDACTED]", body["state"]["request"])

    def test_redact_masks_common_secret_shapes(self):
        sys.path.insert(0, str(self.dir))
        self.addCleanup(sys.path.remove, str(self.dir))
        import claude_jev
        cases = {
            "export GITHUB_TOKEN=\"abc def\"": "export GITHUB_TOKEN=[REDACTED]",
            '{"api_key": "v4lue", "name": "ok"}': '{"api_key": [REDACTED], "name": "ok"}',
            "mysql -u root --password=hunter2 db": "mysql -u root --password=[REDACTED] db",
            "sshpass -p hunter2 ssh host": "sshpass -p [REDACTED] ssh host",
            "mysql -u root -pS3cret db; mkdir -p keep": "mysql -u root -p[REDACTED] db; mkdir -p keep",
            "mysql -u root -p db": "mysql -u root -p db",
            "mkdir -p /tmp/a/b && cp -p a b": "mkdir -p /tmp/a/b && cp -p a b",
            "git log -p -1": "git log -p -1",
            "docker run -p 8080:80 nginx": "docker run -p 8080:80 nginx",
            "pg_dump --password s3|gzip": "pg_dump --password [REDACTED]|gzip",
            "aws AKIAABCDEFGHIJKLMNOP": "aws [REDACTED]",
            "slack xoxb-123456789012-abcdef": "slack [REDACTED]",
            "pat github_pat_11ABCDEFG0123456789": "pat [REDACTED]",
            "rm -rf build/ && git push --force origin main": "rm -rf build/ && git push --force origin main",
            "Authorization: Bearer x": "Authorization: Bearer [REDACTED]",
            "curl -H 'auth=abc'": "curl -H 'auth=[REDACTED]'",
            "curl -H 'X-Auth-Token: abc'": "curl -H 'X-Auth-Token: [REDACTED]'",
            "export AUTH_TOKEN=abc": "export AUTH_TOKEN=[REDACTED]",
            '{"auth": "v"}': '{"auth": [REDACTED]}',
            "Co-Authored-By: Claude Opus": "Co-Authored-By: Claude Opus",
            "author: Jane": "author: Jane",
            "Authorization: Basic dXNlcjpwYXNz": "Authorization: Basic [REDACTED]",
            "curl -H 'Authorization: token abc' x": "curl -H 'Authorization: token [REDACTED]' x",
            "gh api --token abc123secret x": "gh api --token [REDACTED] x",
            "tool --api-key abc --secret='s 1'": "tool --api-key [REDACTED] --secret=[REDACTED]",
            "curl -u admin:hunter2 https://x": "curl -u admin:[REDACTED] https://x",
            "mysql -u root db": "mysql -u root db",
            "Authorization happens in the gateway; the token expired, basic idea": (
                "Authorization happens in the gateway; the token expired, basic idea"),
        }
        for raw, expected in cases.items():
            self.assertEqual(claude_jev.redact(raw), expected, raw)
        self.assertEqual(claude_jev.redact({"a": ["Bearer xyz", 3]}), {"a": ["Bearer [REDACTED]", 3]})

    def test_patterns_stay_fast_on_adversarial_input(self):
        sys.path.insert(0, str(self.dir))
        self.addCleanup(sys.path.remove, str(self.dir))
        import claude_jev
        for unit in ("token-", "api_key.", "a.", "-p", "mysql ", "sshpass ", "find ", "curl |", "systemctl stop ",
                     "systemctl -a ", "x://a", "Authorization: ", "-u a", "git -C x ", "git --a ", "git -c "):
            raw = (unit * 4000)[:4000]
            started = time.perf_counter()
            claude_jev.redact(raw)
            claude_jev.RISKY_BASH.search(raw)
            claude_jev.SELF_DISABLE.search(raw)
            self.assertLess(time.perf_counter() - started, 0.5, unit)

    def test_long_values_are_redacted_before_truncation(self):
        url = "https://deploy:glpat-ABCDEFGHIJKLMNOPQRST@gitlab.com/x"
        command = "git push " + "a" * (4000 - len("git push ") - 30) + " " + url  # the 4000 cut falls inside the token
        self.gateway.replies.append((200, choice("risk", "confirm", 0.9)))
        self.run_hook("bash-gate", self.bash(command))
        _, body = self.gateway.requests[0]
        self.assertNotIn("glpat", json.dumps(body))
        self.assertLessEqual(len(body["state"]["command"]), 4000)
        transcript = self.turn(("Bash", {"command": "echo " + "b" * 160 + " " + url}),
                               *[("Read", {"file_path": f"f{i}"}) for i in range(14)])
        event = {"hook_event_name": "PostToolUse", "tool_name": "Read", "session_id": "s4",
                 "transcript_path": transcript, "tool_input": {}}
        self.gateway.replies.append((200, choice("direction", "on_track", 0.9)))
        for _ in range(15):
            self.run_hook("drift", event)
        _, body = self.gateway.requests[1]
        self.assertNotIn("glpat", json.dumps(body))


if __name__ == "__main__":
    unittest.main()
