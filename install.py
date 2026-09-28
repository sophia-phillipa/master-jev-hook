#!/usr/bin/env python3
"""Installs the master-jev-hook MCP server in Claude Code, Claude Desktop and Codex,
plus the Claude Code hooks and the orchestration instructions."""
import argparse
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
from urllib.parse import urlsplit
import zipfile

ROOT = Path(__file__).resolve().parent
NAME = "master-jev-hook"
BEGIN = "<!-- master-jev-hook-claude:begin -->"
END = "<!-- master-jev-hook-claude:end -->"
CODEX_BEGIN, CODEX_END = "<!-- master-jev-hook:begin -->", "<!-- master-jev-hook:end -->"
TOML_BEGIN, TOML_END = "# master-jev-hook:begin", "# master-jev-hook:end"
TARGETS = ("claude-code", "claude-desktop", "codex")
JEV_TOOLS = "mcp__" + NAME + "__.*"
# (event, matcher, claude_jev.py mode, statusMessage, timeout in s): session instructions and a live gateway test, a
# reminder of the rule on every message, a visible notice before/after each JEV MCP tool call, and
# decision points that consult the gateway (always fail-open).
HOOKS = (("SessionStart", "startup|resume|clear|compact|fork", "hook", "🔷 Master-JEV Hook: checking the gateway with a live JEV test…", 5),
         ("UserPromptSubmit", None, "prompt", None, 3),
         ("PreToolUse", JEV_TOOLS, "pre", "🔷 Consulting JEV…", 3),
         ("PostToolUse", JEV_TOOLS, "post", None, 3),
         ("PreToolUse", "Bash", "bash-gate", "🔷 JEV evaluating the command…", 8),
         ("Stop", None, "stop-check", "🔷 JEV verifying completion…", 10),
         ("PreCompact", None, "precompact", "🔷 JEV choosing what to preserve…", 12),
         ("PostToolUse", None, "drift", None, 8))
MANAGED = "<!-- master-jev-hook-claude:managed -->"


def skill_zip(raw):
    """Deterministic ZIP (fixed timestamp) of the skill folder, for upload in Claude Desktop."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        info = zipfile.ZipInfo("master-jev-hook/SKILL.md", date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, raw)
    return buffer.getvalue()


def safe_target(path):
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError("Target has a symlink: " + str(path))
    if path.exists() and not path.is_file():
        raise ValueError("Target is not a file: " + str(path))


def atomic_write(path, raw, mode=None):
    if mode is None:  # Keep the user's own permissions on an existing file; new files are private.
        mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".jev-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            os.fchmod(stream.fileno(), mode)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def absolute(value):
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError("Use an absolute path: " + str(path))
    # Some distributions expose the user's home directory through a symlink. Normalize
    # that known prefix; safe_target still refuses links inside it.
    user_home = Path.home()
    if path.is_relative_to(user_home):
        path = user_home.resolve() / path.relative_to(user_home)
    return path


def validate_platform():
    if sys.version_info < (3, 11):
        raise ValueError("Python 3.11+ is required")
    if sys.platform == "win32" and sys.version_info < (3, 13):
        raise ValueError("Native Windows requires Python 3.13+ (os.fchmod)")


def validate_node(node):
    if not node.is_file() or not os.access(node, os.X_OK):
        raise ValueError("Node not found or not executable")
    try:
        version = subprocess.run([str(node), "--version"], capture_output=True, text=True,
                                 check=True, timeout=5).stdout.strip()
        major, minor, *_ = (int(part) for part in version.removeprefix("v").split("."))
    except (OSError, ValueError, subprocess.SubprocessError):
        raise ValueError("Could not validate Node") from None
    if (major, minor) < (22, 15):
        raise ValueError("Node >=22.15 is required")


def validate_gateway_url(value):
    try:
        url = urlsplit(value)
        valid = (url.scheme in ("http", "https") and bool(url.hostname)
                 and url.username is None and url.password is None
                 and not url.query and not url.fragment and url.path in ("", "/")
                 and url.port is not None and 1 <= url.port <= 65535)
    except ValueError:
        valid = False
    if not valid:
        raise ValueError("Invalid gateway URL; use http(s)://host:port")


def stale_hook(command, current):
    """A claude_jev.py hook from a previous installation (different prefix, different Python, or a removed mode)."""
    if not isinstance(command, str) or command in current:
        return False
    try:
        argv = shlex.split(command)
    except ValueError:
        return False
    return len(argv) == 3 and Path(argv[1]).name == "claude_jev.py"


def desktop_default():
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/Claude/claude_desktop_config.json"
    if sys.platform == "win32":
        return Path(os.environ["APPDATA"]) / "Claude/claude_desktop_config.json"
    return Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "Claude/claude_desktop_config.json"


def read_json(path):
    safe_target(path)
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    if not isinstance(data, dict) or not isinstance(data.get("mcpServers", {}), dict):
        raise ValueError("invalid_config: " + str(path))
    return data


def mcp_config(data, node, script, gateway_url, path, always_load=False):
    servers = data.setdefault("mcpServers", {})
    old = servers.get(NAME, {})
    if not isinstance(old, dict):
        raise ValueError("invalid_mcp_server: " + str(path))
    if "url" in old or old.get("type", "stdio") != "stdio" or old.get("transport", "stdio") != "stdio":
        raise ValueError("MCP conflict: existing server uses a different transport in " + str(path))
    env = old.get("env", {})
    if not isinstance(env, dict):
        raise ValueError("invalid_mcp_env: " + str(path))
    servers[NAME] = {**old, "command": str(node), "args": [str(script)],
                     "env": {**env, "MASTER_JEV_GATEWAY_URL": gateway_url}}
    if always_load:
        # Claude Code connects MCP servers asynchronously and defers tools that arrive late; the server-level
        # flag makes startup wait for them, which the per-tool _meta flag alone does not.
        servers[NAME]["alwaysLoad"] = True
    return (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def strip_managed_block(old, begin=BEGIN, end=END):
    """The inverse of managed_memory: removes the block plus the blank line it was joined with,
    keeping every other byte of the surrounding content untouched."""
    if old.count(begin) != old.count(end) or old.count(begin) > 1:
        raise ValueError("invalid_memory_markers")
    if begin not in old:
        return old
    start, stop = old.index(begin), old.index(end) + len(end)
    if stop < start + len(end):
        raise ValueError("invalid_memory_markers")
    before, after = old[:start].rstrip("\n"), old[stop:].lstrip("\n")
    if before and after:
        return before + "\n\n" + after
    if before:
        return before + "\n"
    return after


def managed_memory(old, guide, begin=BEGIN, end=END):
    if old.count(begin) != old.count(end) or old.count(begin) > 1:
        raise ValueError("invalid_memory_markers")
    block = begin + "\n" + guide + "\n" + end
    if begin in old:
        start, stop = old.index(begin), old.index(end)
        if stop < start:
            raise ValueError("invalid_memory_markers")
        return old[:start] + block + old[stop + len(end):]
    return old.rstrip() + ("\n\n" if old.strip() else "") + block + "\n"


def codex_config(old, node, script, gateway_url, path):
    """config.toml with the MCP server in a delimited block; refuses a definition of it outside the block."""
    outside = managed_memory(old, "", TOML_BEGIN, TOML_END)
    if NAME in tomllib.loads(outside).get("mcp_servers", {}):
        raise ValueError(f"MCP conflict: [mcp_servers.{NAME}] already defined outside the {TOML_BEGIN} block in {path}")
    expected = {"command": str(node), "args": [str(script)], "env": {"MASTER_JEV_GATEWAY_URL": gateway_url}}
    q = lambda value: json.dumps(value, ensure_ascii=False)  # JSON strings are valid TOML basic strings.
    block = (f"[mcp_servers.{NAME}]\ncommand = {q(str(node))}\nargs = [{q(str(script))}]\n"
             f"env = {{ MASTER_JEV_GATEWAY_URL = {q(gateway_url)} }}")
    new = managed_memory(old, block, TOML_BEGIN, TOML_END)
    if tomllib.loads(new).get("mcp_servers", {}).get(NAME) != expected:
        raise ValueError("invalid_config: the master-jev-hook block would become invalid in " + str(path))
    return new.encode("utf-8")


def plan(targets, home, prefix, node, code_config, desktop_config, codex_home, gateway_url):
    script = prefix / "master-jev-mcp.mjs"
    helper = prefix / "claude_jev.py"
    guide_path = prefix / "master-jev-hook-claude.md"
    chat_guide_path = prefix / "master-jev-hook-claude-chat.md"
    helper_config = prefix / "claude_jev.json"
    skill = (ROOT / "skills/master-jev-hook/SKILL.md").read_bytes()
    skill_path = home / "skills/master-jev-hook/SKILL.md"
    rule_path = home / "rules/master-jev-hook.md"
    codex_toml, codex_agents = codex_home / "config.toml", codex_home / "AGENTS.md"
    destinations = [script, helper, guide_path, chat_guide_path, helper_config, prefix / "master-jev-hook-skill.zip"]
    if "claude-code" in targets:
        destinations.extend((home / "settings.json", home / "CLAUDE.md", rule_path, code_config, skill_path))
    if "claude-desktop" in targets:
        destinations.append(desktop_config)
    if "codex" in targets:
        destinations.extend((codex_toml, codex_agents))
    normalized = [os.path.normpath(str(path)) for path in destinations]
    if len(normalized) != len(set(normalized)):
        raise ValueError("Destination paths collide")
    guide = (ROOT / "master-jev-hook-claude.md").read_text(encoding="utf-8")
    changes = {script: (ROOT / "gateway/bin/master-jev-mcp.mjs").read_bytes(),
               helper: (ROOT / "claude_jev.py").read_bytes(), guide_path: guide.encode("utf-8"),
               chat_guide_path: (ROOT / "master-jev-hook-claude-chat.md").read_bytes(),
               prefix / "master-jev-hook-skill.zip": skill_zip(skill)}
    # The Claude Code hooks' own settings: another target must not rewrite a file the claude-code target made
    # (guide_in_memory true), but keeps its own copy current, since scripts/verify.sh reads gateway_url from it.
    try:
        claude_owned = json.loads(helper_config.read_text(encoding="utf-8")).get("guide_in_memory") is True
    except (OSError, ValueError, AttributeError):
        claude_owned = False
    if "claude-code" in targets or not claude_owned:
        changes[helper_config] = (json.dumps({"gateway_url": gateway_url, "guide_in_memory": "claude-code" in targets},
                                             ensure_ascii=False) + "\n").encode("utf-8")
    if "claude-code" in targets:
        settings_path = home / "settings.json"
        safe_target(settings_path)
        settings = json.loads(settings_path.read_text(encoding="utf-8")) if settings_path.exists() else {}
        if not isinstance(settings, dict) or not isinstance(settings.get("hooks", {}), dict):
            raise ValueError("invalid_settings")
        python = str(Path(sys.executable).resolve())
        current = {" ".join(map(shlex.quote, (python, str(helper), mode))) for _, _, mode, _, _ in HOOKS}
        for groups in settings.get("hooks", {}).values():  # Remove hooks from previous installations.
            if not isinstance(groups, list):
                continue
            for group in groups:
                if isinstance(group, dict) and isinstance(group.get("hooks"), list):
                    group["hooks"] = [h for h in group["hooks"]
                                      if not (isinstance(h, dict) and stale_hook(h.get("command"), current))]
            groups[:] = [g for g in groups if not isinstance(g, dict) or g.get("hooks") != []]
        for event, matcher, mode, status, timeout in HOOKS:
            groups = settings.setdefault("hooks", {}).setdefault(event, [])
            if not isinstance(groups, list) or any(not isinstance(g, dict) or not isinstance(g.get("hooks", []), list)
                    or any(not isinstance(h, dict) for h in g.get("hooks", [])) for g in groups):
                raise ValueError("invalid_hooks")
            command = " ".join(map(shlex.quote, (python, str(helper), mode)))
            hook = {"type": "command", "command": command, "timeout": timeout, **({"statusMessage": status} if status else {})}
            group = {**({"matcher": matcher} if matcher else {}), "hooks": [hook]}
            existing = [i for i, g in enumerate(groups) if any(h.get("command") == command for h in g.get("hooks", []))]
            if not existing:
                groups.append(group)
            elif len(groups[existing[0]].get("hooks", [])) == 1:
                groups[existing[0]] = group  # Group is ours alone: update matcher, timeout and status.
        changes[settings_path] = (json.dumps(settings, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        # The guide now loads as a rule file (below), not a block in CLAUDE.md; migrate away any legacy
        # block from an earlier install, touching nothing else in the user's own memory file.
        memory = home / "CLAUDE.md"
        safe_target(memory)
        if memory.exists():
            old = memory.read_text(encoding="utf-8")
            stripped = strip_managed_block(old)
            if stripped != old:
                changes[memory] = stripped.encode("utf-8")
        changes[code_config] = mcp_config(read_json(code_config), node, script, gateway_url, code_config, always_load=True)
        safe_target(skill_path)
        if skill_path.exists() and MANAGED not in skill_path.read_text(encoding="utf-8"):
            raise ValueError("Existing file is not managed: " + str(skill_path))
        changes[skill_path] = skill
        safe_target(rule_path)
        if rule_path.exists() and MANAGED not in rule_path.read_text(encoding="utf-8"):
            raise ValueError("Existing file is not managed: " + str(rule_path))
        changes[rule_path] = (MANAGED + "\n\n" + guide).encode("utf-8")
    if "claude-desktop" in targets:
        changes[desktop_config] = mcp_config(read_json(desktop_config), node, script, gateway_url, desktop_config)
    if "codex" in targets:
        for path in (codex_toml, codex_agents):
            safe_target(path)
        old = codex_toml.read_text(encoding="utf-8") if codex_toml.exists() else ""
        changes[codex_toml] = codex_config(old, node, script, gateway_url, codex_toml)
        old = codex_agents.read_text(encoding="utf-8") if codex_agents.exists() else ""
        changes[codex_agents] = managed_memory(old, (ROOT / "master-jev-hook-codex.md").read_text(encoding="utf-8").strip(),
                                               CODEX_BEGIN, CODEX_END).encode("utf-8")
    for path in changes:
        safe_target(path)
    for path in (home / "settings.json", code_config, desktop_config):
        if path in changes:
            changes[path] = keep_equal_json(path, changes[path])
    return changes


def keep_equal_json(path, raw):
    """Same JSON content keeps the file's bytes: clients such as Claude Code own their formatting."""
    try:
        if path.exists() and json.loads(path.read_bytes()) == json.loads(raw):
            return path.read_bytes()
    except ValueError:
        pass
    return raw


def apply(changes, prefix):
    changes = {path: raw for path, raw in changes.items() if not path.exists() or path.read_bytes() != raw}
    if not changes:
        return None
    backup = prefix / "backups" / str(time.time_ns())
    before = {path: (path.read_bytes(), path.stat().st_mode & 0o777) if path.exists() else None for path in changes}
    for path in changes:
        safe_target(path)
    for index, previous in enumerate(before.values()):
        if previous:
            safe_target(backup / str(index))
    safe_target(backup / "restore.json")
    for index, (path, previous) in enumerate(before.items()):
        if previous:
            atomic_write(backup / str(index), previous[0])
    atomic_write(backup / "restore.json", json.dumps({
        "files": [{"path": str(path), "backup": str(i) if before[path] else None,
                   "mode": before[path][1] if before[path] else None}
                  for i, path in enumerate(changes)]}, indent=2).encode("utf-8"))
    written = []
    try:
        for path, raw in changes.items():
            atomic_write(path, raw)
            written.append(path)
    except Exception:
        for path in reversed(written):
            previous = before[path]
            if previous is None:
                path.unlink()
            else:
                atomic_write(path, *previous)
        raise
    return backup


def present(target, home, code_config, desktop_config, codex_home):
    return {"claude-code": home.exists() or code_config.exists(),
            "claude-desktop": desktop_config.parent.exists(),
            "codex": codex_home.exists()}[target]


def install(home, prefix, target="all", code_config=None, desktop_config=None,
            node=None, gateway_url="http://127.0.0.1:8795", dry_run=False, codex_home=None):
    validate_platform()
    home, prefix = absolute(home), absolute(prefix)
    node = absolute(node or shutil.which("node") or "/usr/bin/node")
    validate_node(node)
    config_root = absolute(os.environ.get("CLAUDE_CONFIG_DIR", str(Path.home())))
    code_config = absolute(code_config or config_root / ".claude.json")
    desktop_config = absolute(desktop_config or desktop_default())
    codex_home = absolute(codex_home or os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    if target not in (*TARGETS, "all"):
        raise ValueError("invalid_target")
    validate_gateway_url(gateway_url)
    targets = [target]
    if target == "all":
        targets = [t for t in TARGETS if present(t, home, code_config, desktop_config, codex_home)]
        for skipped in (t for t in TARGETS if t not in targets):
            print(f"Warning: {skipped} not found on this machine; skipping.", file=sys.stderr)
    if not targets:
        raise ValueError("No client found; use --target to install anyway")
    changes = plan(targets, home, prefix, node, code_config, desktop_config, codex_home, gateway_url)
    return (list(changes), None) if dry_run else (list(changes), apply(changes, prefix))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=(*TARGETS, "all"), default="all")
    parser.add_argument("--claude-home", type=absolute,
                        default=Path(os.environ.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude"))))
    parser.add_argument("--code-config", type=absolute)
    parser.add_argument("--desktop-config", type=absolute)
    parser.add_argument("--codex-home", type=absolute)
    parser.add_argument("--prefix", type=absolute, default=Path.home() / ".local/share/master-jev-hook")
    parser.add_argument("--node", type=absolute)
    parser.add_argument("--gateway-url", default="http://127.0.0.1:8795")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        paths, backup = install(args.claude_home, args.prefix, args.target, args.code_config,
                                args.desktop_config, args.node, args.gateway_url, args.dry_run, args.codex_home)
    except (OSError, ValueError) as error:
        parser.exit(1, "Installation aborted: " + str(error) + "\n")
    print("Plan validated" if args.dry_run else "Master-JEV Hook installed")
    for path in paths:
        print(path)
    if backup:
        print("Backup:", backup)
    desktop_config = absolute(args.desktop_config or desktop_default())
    if desktop_config in paths:  # Only print if Desktop is among the targets actually installed.
        print("Claude Desktop: reload the app. For Chat mode to always use the JEV,",
              "paste into the app/project instructions the text from", args.prefix / "master-jev-hook-claude-chat.md",
              "and upload the skill", args.prefix / "master-jev-hook-skill.zip", "under Settings -> Capabilities -> Skills.")
    if not args.dry_run:
        print("Restart the clients to load the MCP server. The HTTP gateway must be available at", args.gateway_url)


if __name__ == "__main__":
    main()
