# 🔷 Master-JEV Hook Gateway

[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-blue.svg)](README.md) [![🇧🇷 Português (Brasil)](https://img.shields.io/badge/%F0%9F%87%A7%F0%9F%87%B7-Portugu%C3%AAs%20(Brasil)-green.svg)](README.pt-BR.md)

Local Node.js service that brings JEV's decisions to the agent. It exposes
the decision MCP tools (`bin/master-jev-mcp.mjs`), serves the Master-JEV
Hook HTTP routes, routes tool choice for LLM clients (Codex, Claude Code,
OpenCode, Gemini) and serves a dashboard at `/dashboard`.

Overview, installation and usage: [main README](../README.md).

## ⌨️ Commands

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

## 📄 License

Apache License 2.0. See [LICENSE](../LICENSE) and [NOTICE](../NOTICE); code originally derived from
MIT-licensed jev-gateway is covered in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
