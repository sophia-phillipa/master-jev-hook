import contextlib
import io
import json
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import patch

import install as installer
from install import validate_gateway_url, validate_node


def install(home, prefix, target, code, desktop, **kw):
    """install.install with Codex always in a temporary directory (never the real ~/.codex)."""
    kw.setdefault("codex_home", home.parent / "Codex Home")
    with contextlib.redirect_stderr(io.StringIO()):  # Missing-client warnings on --target all.
        return installer.install(home, prefix, target, code, desktop, **kw)


class ClaudeIntegrationTests(unittest.TestCase):
    def paths(self, root):
        return (root / "Claude Home", root / "assets with spaces",
                root / "Code Config/.claude.json", root / "Desktop Config/claude_desktop_config.json")

    def clients(self, *folders):
        """Simulates installed clients so that --target all finds them."""
        for folder in folders:
            folder.mkdir(parents=True, exist_ok=True)

    def test_all_preserves_settings_mcp_env_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            home, prefix, code, desktop = self.paths(Path(directory))
            home.mkdir()
            settings = {"permissions": {"deny": ["Bash(rm *)"]}, "hooks": {
                "SessionStart": [{"hooks": [{"type": "command", "command": "existing"}]}]}}
            (home / "settings.json").write_text(json.dumps(settings))
            (home / "CLAUDE.md").write_text("Existing instructions\n")
            for path in (code, desktop):
                path.parent.mkdir()
                path.write_text(json.dumps({"other": "secret", "mcpServers": {
                    "other-server": {"command": "old"}, "master-jev-hook": {
                        "env": {"MASTER_JEV_GATEWAY_KEY": "private", "EXTRA": "kept"}}}}))
            install(home, prefix, "all", code, desktop, node=shutil.which("node"))
            before = {p: p.read_bytes() for p in (home / "settings.json", home / "CLAUDE.md", code, desktop)}
            install(home, prefix, "all", code, desktop, node=shutil.which("node"))
            self.assertFalse((Path(directory) / "Codex Home").exists())  # Missing client: skipped.
            self.assertEqual(before, {p: p.read_bytes() for p in before})
            self.assertEqual(len(list((prefix / "backups").iterdir())), 1)
            self.assertEqual(json.loads(before[home / "settings.json"])["permissions"], settings["permissions"])
            self.assertEqual(json.loads(before[home / "settings.json"])["hooks"]["SessionStart"][0], settings["hooks"]["SessionStart"][0])
            self.assertTrue(before[home / "CLAUDE.md"].decode().startswith("Existing instructions\n"))
            chat_guide = (prefix / "master-jev-hook-claude-chat.md").read_text()
            self.assertIn("request_decision", chat_guide)
            self.assertNotIn("master-jev-hook-claude-chat", before[home / "CLAUDE.md"].decode())
            for path in (code, desktop):
                data = json.loads(before[path])
                self.assertEqual(data["other"], "secret")
                self.assertEqual(data["mcpServers"]["other-server"]["command"], "old")
                mcp = data["mcpServers"]["master-jev-hook"]
                self.assertTrue(Path(mcp["command"]).samefile(shutil.which("node")))
                self.assertEqual(mcp["args"], [str(prefix / "master-jev-mcp.mjs")])
                self.assertEqual(mcp["env"]["MASTER_JEV_GATEWAY_KEY"], "private")
                self.assertEqual(mcp["env"]["EXTRA"], "kept")
            self.assertIn("request_decision", before[home / "CLAUDE.md"].decode())
            self.assertNotIn("Qwen", before[home / "CLAUDE.md"].decode())
            for source in ("startup", "resume", "clear", "compact", "fork"):
                # Guide already in CLAUDE.md: SessionStart does not repeat it (token savings).
                result = subprocess.run([sys.executable, str(prefix / "claude_jev.py"), "hook"],
                    input=json.dumps({"hook_event_name": "SessionStart", "source": source}),
                    text=True, capture_output=True, check=True, timeout=3)
                self.assertEqual(result.stdout, "")
            hooks = json.loads(before[home / "settings.json"])["hooks"]
            for event, count in (("UserPromptSubmit", 1), ("PreToolUse", 2), ("PostToolUse", 2),
                                 ("Stop", 1), ("PreCompact", 1)):
                ours = [h for g in hooks[event] for h in g["hooks"] if str(prefix / "claude_jev.py") in h["command"]]
                self.assertEqual(len(ours), count, event)
                self.assertTrue(all(h["timeout"] <= 12 for h in ours), event)
            tool = "mcp__master-jev-hook__request_decision"
            self.assertEqual([g["matcher"] for g in hooks["PreToolUse"]],
                             ["mcp__master-jev-hook__.*", "Bash"])
            self.assertEqual(json.loads((prefix / "claude_jev.json").read_text()),
                             {"gateway_url": "http://127.0.0.1:8795", "guide_in_memory": True})

            def run(mode, event):
                result = subprocess.run([sys.executable, str(prefix / "claude_jev.py"), mode],
                    input=json.dumps(event), text=True, capture_output=True, check=True, timeout=3)
                return json.loads(result.stdout) if result.stdout.strip() else None

            prompt = run("prompt", {"hook_event_name": "UserPromptSubmit", "prompt": "hi"})
            self.assertIn("Mandatory", prompt["hookSpecificOutput"]["additionalContext"])
            pre = run("pre", {"hook_event_name": "PreToolUse", "tool_name": tool,
                              "tool_input": {"objective": "Choose the source", "context": {"kind": "comparison"}}})
            self.assertEqual(pre["systemMessage"], "🔷 Consulting JEV now for: Choose the source")
            pre = run("pre", {"hook_event_name": "PreToolUse", "tool_name": "mcp__master-jev-hook__jev_rank",
                              "tool_input": {"criterion": "Best source", "candidates": []}})
            self.assertEqual(pre["systemMessage"], "🔷 Consulting JEV now for: Best source")
            typed = {"status": "partial", "answers": {
                "a": {"type": "choice", "status": "ok", "choice": "x", "confidence": 0.8},
                "b": {"type": "score", "status": "ok", "score": 0.75, "confidence": 0.9},
                "c": {"type": "noul", "status": "ok", "noul": 0.2},
                "d": {"type": "choice", "status": "abstain"}}}
            post = run("post", {"hook_event_name": "PostToolUse", "tool_name": "mcp__master-jev-hook__jev_score",
                                "tool_response": [{"type": "text", "text": json.dumps(typed)}]})
            self.assertEqual(post["systemMessage"], "🔷 JEV answered a=`x` (0.80), b=0.75, c: P(yes)=0.20.")
            answer = {"status": "accepted", "assessments": {"selection": {"status": "accepted",
                      "choice": "sqlite_local", "confidence": 0.98}}}
            for response in (answer, [{"type": "text", "text": json.dumps(answer)}], json.dumps(answer)):
                post = run("post", {"hook_event_name": "PostToolUse", "tool_name": tool, "tool_response": response})
                self.assertEqual(post["systemMessage"], "🔷 JEV chose `sqlite_local` (confidence 0.98).")
            post = run("post", {"hook_event_name": "PostToolUse", "tool_name": tool,
                                "tool_response": {"status": "abstain", "reason": "low_confidence"}})
            self.assertIn("JEV no decision (low_confidence)", post["systemMessage"])
            self.assertIsNone(run("pre", {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {}}))

    def test_all_skips_missing_clients_and_fails_without_any(self):
        with tempfile.TemporaryDirectory() as directory:
            home, prefix, code, desktop = self.paths(Path(directory))
            codex = Path(directory) / "Codex Home"
            with self.assertRaisesRegex(ValueError, "No client"):
                install(home, prefix, "all", code, desktop, node=shutil.which("node"))
            self.assertFalse(prefix.exists())
            self.clients(desktop.parent)
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                paths, _ = installer.install(home, prefix, "all", code, desktop,
                                             node=shutil.which("node"), codex_home=codex)
            self.assertIn("claude-code not found", err.getvalue())
            self.assertIn("codex not found", err.getvalue())
            self.assertIn(desktop, paths)
            self.assertFalse(home.exists())
            self.assertFalse(code.exists())
            self.assertFalse(codex.exists())

    def test_previous_install_hooks_are_replaced_and_agent_files_kept(self):
        with tempfile.TemporaryDirectory() as directory:
            home, prefix, code, desktop = self.paths(Path(directory))
            (home / "agents").mkdir(parents=True)
            agent = "---\nname: my-agent\n---\nMy agent's instructions.\n"
            (home / "agents/my-agent.md").write_text(agent)
            old = Path(directory) / "old prefix/claude_jev.py"
            command = lambda mode: f"{sys.executable} '{old}' {mode}"
            settings = {"hooks": {
                "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "mine"},
                                                             {"type": "command", "command": command("bash-gate")}]}],
                "UserPromptSubmit": [{"hooks": [{"type": "command", "command": command("prompt")}]}]}}
            (home / "settings.json").write_text(json.dumps(settings))
            install(home, prefix, "claude-code", code, desktop, node=shutil.which("node"))
            hooks = json.loads((home / "settings.json").read_text())["hooks"]
            commands = [h["command"] for groups in hooks.values() for g in groups for h in g["hooks"]]
            self.assertFalse([c for c in commands if str(old) in c])  # Our hooks from another prefix leave.
            self.assertIn("mine", commands)  # A third-party hook stays.
            self.assertEqual(len([c for c in commands if str(prefix / "claude_jev.py") in c]), len(installer.HOOKS))
            self.assertEqual((home / "agents/my-agent.md").read_text(), agent)
            result = subprocess.run([sys.executable, str(prefix / "claude_jev.py"), "unknown-mode"], input="{}",
                                    text=True, capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 0)  # Fail-open: an unknown mode never blocks PreToolUse.
            self.assertEqual(result.stdout, "")

    def test_skill_is_installed_for_code_and_zipped_for_desktop(self):
        import zipfile
        with tempfile.TemporaryDirectory() as directory:
            home, prefix, code, desktop = self.paths(Path(directory))
            self.clients(home, desktop.parent)
            install(home, prefix, "all", code, desktop, node=shutil.which("node"))
            skill = (home / "skills/master-jev-hook/SKILL.md").read_text()
            self.assertTrue(skill.startswith("---\nname: master-jev-hook\n"))
            self.assertIn("<!-- master-jev-hook-claude:managed -->", skill)
            with zipfile.ZipFile(prefix / "master-jev-hook-skill.zip") as archive:
                self.assertEqual(archive.namelist(), ["master-jev-hook/SKILL.md"])
                self.assertEqual(archive.read("master-jev-hook/SKILL.md").decode(), skill)
            before = (prefix / "master-jev-hook-skill.zip").read_bytes()
            _, backup = install(home, prefix, "all", code, desktop, node=shutil.which("node"))
            self.assertIsNone(backup)
            self.assertEqual(before, (prefix / "master-jev-hook-skill.zip").read_bytes())
            memory = (home / "CLAUDE.md").read_text()
            self.assertIn("master-jev-hook", memory)
            self.assertLess(len(memory), 3500)

    def test_existing_unmanaged_skill_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            home, prefix, code, desktop = self.paths(Path(directory))
            (home / "skills/master-jev-hook").mkdir(parents=True)
            (home / "skills/master-jev-hook/SKILL.md").write_text("minha\n")
            with self.assertRaisesRegex(ValueError, "master-jev-hook"):
                install(home, prefix, "claude-code", code, desktop, node=shutil.which("node"))
            self.assertEqual((home / "skills/master-jev-hook/SKILL.md").read_text(), "minha\n")

    def test_json_configs_with_same_content_keep_their_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            home, prefix, code, desktop = self.paths(Path(directory))
            self.clients(home, desktop.parent)
            install(home, prefix, "all", code, desktop, node=shutil.which("node"))
            for path in (home / "settings.json", code, desktop):
                path.write_text(json.dumps(json.loads(path.read_text()), separators=(",", ":")))
            before = {p: p.read_bytes() for p in (home / "settings.json", code, desktop)}
            paths, backup = install(home, prefix, "all", code, desktop, node=shutil.which("node"))
            self.assertIsNone(backup)
            self.assertEqual(before, {p: p.read_bytes() for p in before})

    def test_reinstall_updates_matcher_of_existing_hook(self):
        with tempfile.TemporaryDirectory() as directory:
            home, prefix, code, desktop = self.paths(Path(directory))
            install(home, prefix, "claude-code", code, desktop, node=shutil.which("node"))
            settings = json.loads((home / "settings.json").read_text())
            settings["hooks"]["PreToolUse"][0]["matcher"] = "mcp__master-jev-hook__request_decision"
            settings["hooks"]["PreToolUse"][0]["hooks"][0]["timeout"] = 3
            (home / "settings.json").write_text(json.dumps(settings))
            install(home, prefix, "claude-code", code, desktop, node=shutil.which("node"))
            groups = json.loads((home / "settings.json").read_text())["hooks"]["PreToolUse"]
            self.assertEqual(len(groups), 2)
            self.assertEqual(groups[0]["matcher"], "mcp__master-jev-hook__.*")

    def test_targets_and_dry_run(self):
        with tempfile.TemporaryDirectory() as directory:
            home, prefix, code, desktop = self.paths(Path(directory))
            for target in ("claude-code", "claude-desktop", "codex"):
                install(home, prefix, target, code, desktop, node=shutil.which("node"), dry_run=True)
            self.assertFalse(home.exists())
            self.assertFalse(desktop.exists())
            self.assertFalse(prefix.exists())
            install(home, prefix, "claude-desktop", code, desktop, node=shutil.which("node"))
            self.assertTrue(desktop.exists())
            self.assertFalse(home.exists())
            install(home, prefix, "claude-code", code, desktop, node=shutil.which("node"))
            self.assertTrue((home / "settings.json").exists())
            self.assertTrue(code.exists())

    def test_invalid_config_and_symlink_fail_before_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            home, prefix, code, desktop = self.paths(Path(directory))
            code.parent.mkdir()
            code.write_text("{")
            with self.assertRaises(ValueError):
                install(home, prefix, "all", code, desktop, node=shutil.which("node"))
            self.assertFalse(home.exists())
            self.assertFalse(prefix.exists())
            code.unlink()
            code.symlink_to(desktop)
            with self.assertRaisesRegex(ValueError, "symlink"):
                install(home, prefix, "claude-code", code, desktop, node=shutil.which("node"))
            self.assertFalse(prefix.exists())

    def test_write_failure_rolls_back(self):
        with tempfile.TemporaryDirectory() as directory:
            home, prefix, code, desktop = self.paths(Path(directory))
            self.clients(home, desktop.parent)
            desktop.write_text('{"untouched": true}')
            atomic_write = installer.atomic_write
            def fail(path, *args):
                if path == desktop:
                    raise OSError("simulated")
                return atomic_write(path, *args)
            with patch("install.atomic_write", side_effect=fail):
                with self.assertRaises(OSError):
                    install(home, prefix, "all", code, desktop, node=shutil.which("node"))
            self.assertEqual(desktop.read_text(), '{"untouched": true}')
            self.assertFalse((home / "settings.json").exists())
            self.assertFalse(code.exists())

    def test_transport_collision_and_legacy_hook_migration(self):
        with tempfile.TemporaryDirectory() as directory:
            home, prefix, code, desktop = self.paths(Path(directory))
            home.mkdir()
            old_command = f"{sys.executable} '{home / 'jev/claude_jev.py'}' hook"
            settings = {"hooks": {"SessionStart": [{"matcher": "startup|resume|clear|compact|fork",
                "hooks": [{"type": "command", "command": old_command}]},
                {"hooks": [{"type": "command", "command": "other"}]}]}}
            (home / "settings.json").write_text(json.dumps(settings))
            code.parent.mkdir()
            code.write_text(json.dumps({"mcpServers": {"master-jev-hook": {
                "type": "http", "url": "http://example.test"}}}))
            with self.assertRaisesRegex(ValueError, "MCP conflict"):
                install(home, prefix, "claude-code", code, desktop, node=shutil.which("node"))
            self.assertFalse(prefix.exists())
            self.assertEqual(json.loads((home / "settings.json").read_text()), settings)
            code.write_text("{}")
            install(home, prefix, "claude-code", code, desktop, node=shutil.which("node"))
            groups = json.loads((home / "settings.json").read_text())["hooks"]["SessionStart"]
            self.assertEqual(len(groups), 2)
            commands = [hook["command"] for group in groups for hook in group["hooks"]]
            self.assertIn("other", commands)
            self.assertNotIn(old_command, commands)
            self.assertTrue(any(str(prefix / "claude_jev.py") in command for command in commands))

    def test_url_node_and_path_validation(self):
        for value in ("http://", "http://host", "http://user:pass@host:8795", "http://@host:8795",
                      "http://host:bad", "http://host:65536", "http://host:0",
                      "http://host:8795/path", "http://host:8795/?key=x", "http://host:8795/#x"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_gateway_url(value)
        validate_gateway_url("http://127.0.0.1:8795")
        with self.assertRaises(ValueError):
            validate_node(Path("/not/a/node"))
        with tempfile.TemporaryDirectory() as directory:
            home, prefix, code, desktop = self.paths(Path(directory))
            self.clients(home, code.parent)
            with self.assertRaisesRegex(ValueError, "Destination paths collide"):
                install(home, prefix, "all", code, code, node=shutil.which("node"))
            with self.assertRaisesRegex(ValueError, "Destination paths collide"):
                install(home, prefix, "claude-code", prefix / "master-jev-mcp.mjs", desktop,
                        node=shutil.which("node"))
            self.assertFalse(prefix.exists())

    def test_home_alias_is_supported_but_inner_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            physical = root / "physical"
            physical.mkdir()
            alias = root / "alias"
            alias.symlink_to(physical, target_is_directory=True)
            with patch("install.Path.home", return_value=alias):
                home, prefix, code, desktop = self.paths(alias)
                self.clients(code.parent, desktop.parent)
                code.write_text("{}")
                paths, _ = install(home, prefix, "all", code, desktop,
                                   node=shutil.which("node"), dry_run=True)
                self.assertTrue(all(p.is_relative_to(physical) for p in paths))
                (physical / "Claude Home").symlink_to(root / "outside", target_is_directory=True)
                with self.assertRaisesRegex(ValueError, "symlink"):
                    install(home, prefix, "all", code, desktop,
                            node=shutil.which("node"), dry_run=True)

    def test_windows_requires_python_313_before_any_writes(self):
        from install import validate_platform
        with patch("install.sys.platform", "win32"):
            with patch("install.sys.version_info", (3, 12)):
                with self.assertRaisesRegex(ValueError, "3.13"):
                    validate_platform()
            with patch("install.sys.version_info", (3, 13)):
                validate_platform()


class CodexTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        self.codex = self.root / "Codex Home"
        self.codex.mkdir()
        self.prefix = self.root / "prefix"
        self.toml, self.agents = self.codex / "config.toml", self.codex / "AGENTS.md"

    def install(self, **kw):
        kw.setdefault("node", shutil.which("node"))
        return installer.install(self.root / "claude", self.prefix, "codex", self.root / "code.json",
                                 self.root / "desktop.json", codex_home=self.codex, **kw)

    def server(self):
        return tomllib.loads(self.toml.read_text())["mcp_servers"]["master-jev-hook"]

    def test_new_config_and_managed_agents(self):
        paths, _ = self.install()
        self.assertIn(self.toml, paths)
        server = self.server()
        self.assertTrue(Path(server["command"]).samefile(shutil.which("node")))
        self.assertEqual(server["args"], [str(self.prefix / "master-jev-mcp.mjs")])
        self.assertEqual(server["env"], {"MASTER_JEV_GATEWAY_URL": "http://127.0.0.1:8795"})
        text = self.toml.read_text()
        self.assertTrue(text.startswith("# master-jev-hook:begin\n") and text.endswith("# master-jev-hook:end\n"))
        agents = self.agents.read_text()
        self.assertIn("<!-- master-jev-hook:begin -->", agents)
        self.assertIn((installer.ROOT / "master-jev-hook-codex.md").read_text().strip(), agents)
        self.assertFalse((self.root / "claude").exists())
        _, backup = self.install()
        self.assertIsNone(backup)  # Idempotente.

    def test_existing_config_with_other_servers_is_preserved(self):
        original = 'model = "m"\n\n[mcp_servers.other]\ncommand = "o"\nargs = ["a"]\n'
        self.toml.write_text(original)
        self.agents.write_text("# Minhas regras\n")
        self.install()
        data = tomllib.loads(self.toml.read_text())
        self.assertEqual(data["model"], "m")
        self.assertEqual(data["mcp_servers"]["other"], {"command": "o", "args": ["a"]})
        self.assertTrue(self.toml.read_text().startswith(original))
        self.assertTrue(self.agents.read_text().startswith("# Minhas regras\n\n<!-- master-jev-hook:begin -->"))

    def test_block_is_replaced_in_place(self):
        self.install()
        self.toml.write_text(self.toml.read_text() + '\n[mcp_servers.after]\ncommand = "x"\n')
        self.install(gateway_url="http://127.0.0.1:9000")
        text = self.toml.read_text()
        self.assertEqual(text.count("# master-jev-hook:begin"), 1)
        self.assertEqual(self.server()["env"]["MASTER_JEV_GATEWAY_URL"], "http://127.0.0.1:9000")
        self.assertEqual(tomllib.loads(text)["mcp_servers"]["after"], {"command": "x"})
        self.assertEqual(self.agents.read_text().count("<!-- master-jev-hook:begin -->"), 1)

    def test_definition_outside_block_fails_without_changes(self):
        for original in ('[mcp_servers.master-jev-hook]\ncommand = "mine"\n',
                         '[mcp_servers]\n"master-jev-hook" = { command = "mine" }\n'):
            with self.subTest(original=original):
                self.toml.write_text(original)
                with self.assertRaisesRegex(ValueError, "outside the"):
                    self.install()
                self.assertEqual(self.toml.read_text(), original)
                self.assertFalse(self.agents.exists())
                self.assertFalse(self.prefix.exists())

    def test_invalid_toml_fails(self):
        self.toml.write_text("model = \n")
        with self.assertRaises(ValueError):
            self.install()
        self.assertFalse(self.prefix.exists())

    def test_dry_run_writes_nothing(self):
        paths, backup = self.install(dry_run=True)
        self.assertIsNone(backup)
        self.assertEqual({self.toml, self.agents} - set(paths), set())
        self.assertFalse(self.toml.exists())
        self.assertFalse(self.agents.exists())
        self.assertFalse(self.prefix.exists())

    def test_toml_survives_emoji_in_prefix_path(self):
        prefix = self.root / "prefix 🚀"
        paths, _ = installer.install(self.root / "claude", prefix, "codex", self.root / "code.json",
                                     self.root / "desktop.json", codex_home=self.codex,
                                     node=shutil.which("node"))
        self.assertIn(self.toml, paths)
        text = self.toml.read_text(encoding="utf-8")
        self.assertIn("🚀", text)  # ensure_ascii=False: sem par substituto 🚀.
        self.assertNotIn("\\ud83d", text)
        server = tomllib.loads(text)["mcp_servers"]["master-jev-hook"]
        self.assertEqual(server["args"], [str(prefix / "master-jev-mcp.mjs")])
