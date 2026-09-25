#!/usr/bin/env node
// master-jev-claude: run Claude Code through a local Master-JEV Hook. Nothing in ~/.claude is modified.
import { claude } from "./clients.mjs";
import { runLauncher } from "./launcher.mjs";

await runLauncher(claude);
