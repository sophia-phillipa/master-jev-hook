# Master-JEV Hook Gateway

**[English](#english)** | **[Português (Brasil)](#português-brasil)**

---

## English

<a id="english"></a>

Local Node.js service that brings JEV's decisions to the agent. It exposes
the decision MCP tools (`bin/master-jev-mcp.mjs`), serves the Master-JEV
Hook HTTP routes, routes tool choice for LLM clients (Codex, Claude Code,
OpenCode, Gemini) and serves a dashboard at `/dashboard`.

Overview, installation and usage: [main README](../README.md).

### Commands

Requires Node.js 22.15 or newer and pnpm.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck      # type checking
pnpm build          # compiles to dist/ and copies the dashboard
pnpm test           # tests (vitest)
pnpm start          # starts the gateway from dist/
pnpm dev            # development mode, reloads on save
pnpm smoke:install  # packaged installation (after build)
```

Environment variables: see [.env.example](.env.example).

### License

Apache License 2.0. See [LICENSE](../LICENSE) and [NOTICE](../NOTICE); code originally derived from
MIT-licensed jev-gateway is covered in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

---

## Português (Brasil)

<a id="português-brasil"></a>

Serviço local em Node.js que leva as decisões do JEV ao agente. Ele expõe as
ferramentas MCP de decisão (`bin/master-jev-mcp.mjs`), atende as rotas HTTP do
Master-JEV Hook, roteia a escolha de ferramentas de clientes LLM (Codex, Claude Code,
OpenCode, Gemini) e serve um painel em `/dashboard`.

Visão geral, instalação e uso: [README principal](../README.md).

### Comandos

Requer Node.js 22.15 ou mais recente e pnpm.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck      # checagem de tipos
pnpm build          # compila para dist/ e copia o painel
pnpm test           # testes (vitest)
pnpm start          # sobe o gateway a partir de dist/
pnpm dev            # modo de desenvolvimento, recarrega ao salvar
pnpm smoke:install  # instalação empacotada (depois do build)
```

Variáveis de ambiente: veja [.env.example](.env.example).

### Licença

Apache License 2.0. Veja [LICENSE](../LICENSE) e [NOTICE](../NOTICE); o código originalmente derivado
do jev-gateway, sob licença MIT, está descrito em [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
