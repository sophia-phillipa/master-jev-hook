# 🔷 Master-JEV Hook Gateway

[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-blue.svg)](README.md) [![🇧🇷 Português (Brasil)](https://img.shields.io/badge/%F0%9F%87%A7%F0%9F%87%B7-Portugu%C3%AAs%20(Brasil)-green.svg)](README.pt-BR.md)

Serviço local em Node.js que leva as decisões do JEV ao agente. Ele expõe as
ferramentas MCP de decisão (`bin/master-jev-mcp.mjs`), atende as rotas HTTP do
Master-JEV Hook, roteia a escolha de ferramentas de clientes LLM (Codex, Claude Code,
OpenCode, Gemini) e serve um painel em `/dashboard`.

Visão geral, instalação e uso: [README principal](../README.pt-BR.md).

## ⌨️ Comandos

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

## 📄 Licença

Apache License 2.0. Veja [LICENSE](../LICENSE) e [NOTICE](../NOTICE); o código originalmente derivado
do jev-gateway, sob licença MIT, está descrito em [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
