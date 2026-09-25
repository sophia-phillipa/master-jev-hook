# Gateway do Master-JEV Hook

Serviço local em Node.js que leva as decisões do JEV ao agente. Ele expõe as
ferramentas MCP de decisão (`bin/master-jev-mcp.mjs`), atende as rotas HTTP do
Master-JEV Hook, roteia a escolha de ferramentas de clientes LLM (Codex, Claude Code,
OpenCode, Gemini) e serve um painel em `/dashboard`.

Visão geral, instalação e uso: [README principal](../README.md).

## Comandos

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

## Licença

MIT. Veja [LICENSE](../LICENSE) e [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
