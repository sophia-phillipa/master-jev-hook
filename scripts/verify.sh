#!/usr/bin/env bash
# Checks the gateway and the Master-JEV Hook integration in Claude Code, Claude Desktop and Codex, no paid query.
# Usage: scripts/verify.sh   (exits with 1 if any item fails; missing clients are skipped)
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
PREFIX=${PREFIX:-$HOME/.local/share/master-jev-hook}
INSTALLED_URL=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['gateway_url'])" "$PREFIX/claude_jev.json" 2>/dev/null)
URL=${MASTER_JEV_GATEWAY_URL:-${INSTALLED_URL:-http://127.0.0.1:8795}}
CLAUDE_HOME=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
CLAUDE_JSON=${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json
if [ "$(uname -s)" = "Darwin" ]; then
  DESKTOP="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
else
  DESKTOP=${XDG_CONFIG_HOME:-$HOME/.config}/Claude/claude_desktop_config.json
fi
CODEX=${CODEX_HOME:-$HOME/.codex}
ENV_FILE="$HOME/.config/master-jev-hook/gateway.env"
failures=0
ok() { printf '  ok     %s\n' "$1"; }
fail() { printf '  FAIL   %s\n' "$1"; failures=$((failures + 1)); }
check() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else fail "$1"; fi; }
mcp_json() { check "MCP in $1" "python3 -c \"import json,sys;assert 'master-jev-hook' in json.load(open(sys.argv[1]))['mcpServers']\" '$1'"; }
# Portable permission check: GNU stat (-c) on one system, BSD/macOS stat (-f) on the other.
perm() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null; }

echo "Gateway"
check "dashboard responds at $URL/dashboard" "curl -fsS -o /dev/null --max-time 3 '$URL/dashboard'"
if [ -f "$ENV_FILE" ]; then
  check "private env has permission 600" "[ \"\$(perm '$ENV_FILE')\" = 600 ]"
else
  echo "  skipped (no $ENV_FILE; installation without the systemd service)"
fi
check "dist built" "[ -f '$REPO/gateway/dist/index.js' ]"

echo "Installed files match the repository ($PREFIX)"
for f in claude_jev.py master-jev-hook-claude.md master-jev-hook-claude-chat.md; do
  check "$f" "cmp -s '$REPO/$f' '$PREFIX/$f'"
done
check "master-jev-mcp.mjs" "cmp -s '$REPO/gateway/bin/master-jev-mcp.mjs' '$PREFIX/master-jev-mcp.mjs'"

echo "Claude Code"
if [ -d "$CLAUDE_HOME" ]; then
  check "master-jev-hook skill" "cmp -s '$REPO/skills/master-jev-hook/SKILL.md' '$CLAUDE_HOME/skills/master-jev-hook/SKILL.md'"
  check "managed block in CLAUDE.md" "grep -q 'master-jev-hook-claude:begin' '$CLAUDE_HOME/CLAUDE.md'"
  mcp_json "$CLAUDE_JSON"
  python3 - "$CLAUDE_HOME/settings.json" <<'PY' || failures=$((failures + 1))
import json, sys
try:
    hooks = json.load(open(sys.argv[1])).get("hooks", {})
except (OSError, ValueError):
    hooks = {}
cmds = {h["command"].rsplit(" ", 1)[-1] for groups in hooks.values() for g in groups for h in g.get("hooks", []) if "claude_jev.py" in h.get("command", "")}
expected = {"hook", "prompt", "pre", "post", "bash-gate", "stop-check", "precompact", "drift"}
missing = sorted(expected - cmds)
print("  " + ("ok     8 claude_jev.py hooks in settings.json" if not missing else "FAIL   missing hooks: " + ", ".join(missing)))
sys.exit(1 if missing else 0)
PY
else
  echo "  skipped (no $CLAUDE_HOME)"
fi

echo "Claude Desktop (Chat)"
if [ -d "$(dirname "$DESKTOP")" ]; then mcp_json "$DESKTOP"; else echo "  skipped (no $(dirname "$DESKTOP"))"; fi

echo "Codex"
if [ -d "$CODEX" ]; then
  check "MCP in the master-jev-hook block of config.toml" "python3 -c \"import sys,tomllib;t=open(sys.argv[1]).read();assert '# master-jev-hook:begin' in t;assert 'master-jev-hook' in tomllib.loads(t)['mcp_servers']\" '$CODEX/config.toml'"
  check "managed block in AGENTS.md" "grep -q 'master-jev-hook:begin' '$CODEX/AGENTS.md'"
else
  echo "  skipped (no $CODEX)"
fi

echo
if [ "$failures" -eq 0 ]; then echo "All good."; else echo "$failures item(s) failed. Reinstall with python3 install.py (see the README)."; exit 1; fi
