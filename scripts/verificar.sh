#!/usr/bin/env bash
# Confere o gateway e a integração Master-JEV Hook no Claude Code, Claude Desktop e Codex, sem consulta paga.
# Uso: scripts/verificar.sh   (sai com 1 se algum item falhar; clientes ausentes são pulados)
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
falhas=0
ok() { printf '  ok     %s\n' "$1"; }
falha() { printf '  FALHA  %s\n' "$1"; falhas=$((falhas + 1)); }
checa() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else falha "$1"; fi; }
mcp_json() { checa "MCP em $1" "python3 -c \"import json,sys;assert 'master-jev-hook' in json.load(open(sys.argv[1]))['mcpServers']\" '$1'"; }
# Permissão portável: GNU stat (-c) num sistema, BSD/macOS stat (-f) noutro.
perm() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null; }

echo "Gateway"
checa "painel responde em $URL/dashboard" "curl -fsS -o /dev/null --max-time 3 '$URL/dashboard'"
if [ -f "$ENV_FILE" ]; then
  checa "env privado com permissão 600" "[ \"\$(perm '$ENV_FILE')\" = 600 ]"
else
  echo "  pulado (sem $ENV_FILE; instalação sem o serviço systemd)"
fi
checa "dist compilado" "[ -f '$REPO/gateway/dist/index.js' ]"

echo "Arquivos instalados iguais ao repositório ($PREFIX)"
for f in claude_jev.py master-jev-hook-claude.md master-jev-hook-claude-chat.md; do
  checa "$f" "cmp -s '$REPO/$f' '$PREFIX/$f'"
done
checa "master-jev-mcp.mjs" "cmp -s '$REPO/gateway/bin/master-jev-mcp.mjs' '$PREFIX/master-jev-mcp.mjs'"

echo "Claude Code"
if [ -d "$CLAUDE_HOME" ]; then
  checa "skill master-jev-hook" "cmp -s '$REPO/skills/master-jev-hook/SKILL.md' '$CLAUDE_HOME/skills/master-jev-hook/SKILL.md'"
  checa "bloco gerenciado em CLAUDE.md" "grep -q 'master-jev-hook-claude:begin' '$CLAUDE_HOME/CLAUDE.md'"
  mcp_json "$CLAUDE_JSON"
  python3 - "$CLAUDE_HOME/settings.json" <<'PY' || falhas=$((falhas + 1))
import json, sys
try:
    hooks = json.load(open(sys.argv[1])).get("hooks", {})
except (OSError, ValueError):
    hooks = {}
cmds = {h["command"].rsplit(" ", 1)[-1] for groups in hooks.values() for g in groups for h in g.get("hooks", []) if "claude_jev.py" in h.get("command", "")}
esperado = {"hook", "prompt", "pre", "post", "bash-gate", "stop-check", "precompact", "drift"}
faltam = sorted(esperado - cmds)
print("  " + ("ok     8 hooks claude_jev.py em settings.json" if not faltam else "FALHA  hooks ausentes: " + ", ".join(faltam)))
sys.exit(1 if faltam else 0)
PY
else
  echo "  pulado (sem $CLAUDE_HOME)"
fi

echo "Claude Desktop (Chat)"
if [ -d "$(dirname "$DESKTOP")" ]; then mcp_json "$DESKTOP"; else echo "  pulado (sem $(dirname "$DESKTOP"))"; fi

echo "Codex"
if [ -d "$CODEX" ]; then
  checa "MCP no bloco master-jev-hook de config.toml" "python3 -c \"import sys,tomllib;t=open(sys.argv[1]).read();assert '# master-jev-hook:begin' in t;assert 'master-jev-hook' in tomllib.loads(t)['mcp_servers']\" '$CODEX/config.toml'"
  checa "bloco gerenciado em AGENTS.md" "grep -q 'master-jev-hook:begin' '$CODEX/AGENTS.md'"
else
  echo "  pulado (sem $CODEX)"
fi

echo
if [ "$falhas" -eq 0 ]; then echo "Tudo certo."; else echo "$falhas item(ns) com falha. Reinstale com python3 install.py (veja o README)."; exit 1; fi
