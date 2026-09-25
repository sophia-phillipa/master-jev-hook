#!/usr/bin/env node
// master-jev-codex: run Codex through a local Master-JEV Hook. Nothing in ~/.codex is modified.
import { codex } from "./clients.mjs";
import { runLauncher } from "./launcher.mjs";

await runLauncher(codex);
