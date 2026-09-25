#!/usr/bin/env node
// master-jev-opencode: run OpenCode through a local Master-JEV Hook. Nothing in ~/.config/opencode is modified.
import { opencode } from "./clients.mjs";
import { runLauncher } from "./launcher.mjs";

await runLauncher(opencode);
