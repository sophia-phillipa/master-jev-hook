#!/usr/bin/env node
// Minimal stdio MCP adapter: no inference here, just named tools for our HTTP gateway.
import { createInterface } from "node:readline";
const endpoint = new URL(process.env.MASTER_JEV_GATEWAY_URL ?? "http://127.0.0.1:8795");
if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error("Invalid gateway URL");
const item = { type: "object", additionalProperties: false, required: ["id", "text"], properties: { id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" }, text: { type: "string", minLength: 1, maxLength: 8000 } } };
const text8000 = { type: "string", minLength: 1, maxLength: 8000 };

// --- Argument validation shared by the /master/decide-backed tools. Every check here runs
// locally, before any network call, so malformed arguments never reach the gateway. ---
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const isId = (x) => typeof x === "string" && idPattern.test(x);
const isText = (x, max = 8000) => typeof x === "string" && x.length >= 1 && x.length <= max;
const isPlainObject = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const onlyKeys = (obj, keys) => isPlainObject(obj) && Object.keys(obj).every((k) => keys.includes(k));
// Risk of the action the response will guide; the gateway applies increasing thresholds (0.65/0.80/0.90).
const risk = { type: "string", enum: ["low", "medium", "high"], description: "Risk of the action the response will guide: low (read-only, triage), medium (reversible code change), high (irreversible, external, security). Defines the minimum confidence required." };
function withRisk(body, args) {
  if (args.risk === undefined) return body;
  if (!["low", "medium", "high"].includes(args.risk)) invalid("Invalid risk: expected low, medium or high");
  return { ...body, risk: args.risk };
}
function invalid(message) { const e = new Error(message); e.code = -32602; throw e; }
function parseItem(x) {
  if (!isPlainObject(x) || Object.keys(x).length !== 2 || !isId(x.id) || !isText(x.text)) invalid("Invalid item: expected { id, text }");
  return x;
}
function parseItems(arr, min, max) {
  if (!Array.isArray(arr) || arr.length < min || arr.length > max) invalid(`Invalid item list: expected between ${min} and ${max} entries`);
  arr.forEach(parseItem);
  const ids = arr.map((x) => x.id);
  if (new Set(ids).size !== ids.length) invalid("Duplicate item ids");
  return arr;
}

function buildClassify(args) {
  if (!onlyKeys(args, ["purpose", "categories", "items", "risk"])) invalid("Invalid arguments for jev_classify");
  if (args.purpose !== undefined && !isText(args.purpose)) invalid("Invalid purpose");
  const categories = parseItems(args.categories, 2, 64);
  const items = parseItems(args.items, 1, 32);
  const criteria = Object.fromEntries(categories.map((c) => [c.id, c.text]));
  const questions = Object.fromEntries(items.map((it) => [it.id, {
    type: "choice",
    instructions: `Classify the item in \`items.${it.id}\` into the best-fitting category.` + (args.purpose !== undefined ? ` Purpose (see \`purpose\`): ${args.purpose}.` : ""),
    criteria,
  }]));
  const state = { ...(args.purpose !== undefined ? { purpose: args.purpose } : {}), items: Object.fromEntries(items.map((it) => [it.id, it.text])) };
  return withRisk({ state, questions }, args);
}

function buildVerify(args) {
  if (!onlyKeys(args, ["question", "state", "criteria", "risk"])) invalid("Invalid arguments for jev_verify");
  if (!isText(args.question)) invalid("Invalid question");
  if (!isText(args.state)) invalid("Invalid state");
  let criteria;
  if (args.criteria !== undefined) {
    if (!isPlainObject(args.criteria) || Object.keys(args.criteria).length !== 2 || !isText(args.criteria.true) || !isText(args.criteria.false)) invalid("Invalid criteria: expected { true, false }");
    criteria = { true: args.criteria.true, false: args.criteria.false };
  }
  return withRisk({ state: args.state, questions: { verification: { type: "noul", instructions: args.question, ...(criteria ? { criteria } : {}) } } }, args);
}

function buildScore(args) {
  if (!onlyKeys(args, ["state", "criteria", "weights", "risk"])) invalid("Invalid arguments for jev_score");
  if (!isText(args.state)) invalid("Invalid state");
  if (!Array.isArray(args.criteria) || args.criteria.length < 1 || args.criteria.length > 32) invalid("Invalid criteria: expected between 1 and 32 entries");
  const ids = [];
  const questions = {};
  for (const c of args.criteria) {
    if (!isPlainObject(c) || Object.keys(c).length !== 3 || !isId(c.id) || !isText(c.question) || !Array.isArray(c.levels) || c.levels.length < 2 || c.levels.length > 10 || !c.levels.every((n) => isText(n))) invalid("Invalid criterion: expected { id, question, levels }");
    if (ids.includes(c.id)) invalid("Duplicate criterion id");
    ids.push(c.id);
    questions[c.id] = { type: "score", instructions: c.question, criteria: c.levels };
  }
  let composite;
  if (args.weights !== undefined) {
    if (!isPlainObject(args.weights) || Object.keys(args.weights).length === 0) invalid("Invalid weights");
    for (const [k, v] of Object.entries(args.weights)) {
      if (!ids.includes(k)) invalid(`Weight references unknown criterion id "${k}"`);
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) invalid("Invalid weight value: expected a non-negative number");
    }
    // The gateway wants weights in [0, 1] that sum to 1; relative weights are normalized here.
    const sum = Object.values(args.weights).reduce((a, b) => a + b, 0);
    if (!(sum > 0 && Number.isFinite(sum))) invalid("Invalid weights: their sum must be positive and finite");
    composite = Object.fromEntries(Object.entries(args.weights).map(([k, v]) => [k, v / sum]));
  }
  return withRisk({ state: args.state, questions, ...(composite ? { composite } : {}) }, args);
}

// Questions in English (the language jev-1.13 is most precise in), referencing state fields by name.
const DEFAULT_LEVELS = ["Does not meet the criterion", "Weak fit", "Adequate fit", "Good fit", "Excellent fit"];
function buildRank(args) {
  if (!onlyKeys(args, ["criterion", "candidates", "levels", "risk"])) invalid("Invalid arguments for jev_rank");
  if (!isText(args.criterion)) invalid("Invalid criterion");
  const candidates = parseItems(args.candidates, 2, 32);
  let levels = DEFAULT_LEVELS;
  if (args.levels !== undefined) {
    if (!Array.isArray(args.levels) || args.levels.length < 2 || args.levels.length > 10 || !args.levels.every((n) => isText(n))) invalid("Invalid levels");
    levels = args.levels;
  }
  const state = { criterion: args.criterion, candidates: Object.fromEntries(candidates.map((c) => [c.id, c.text])) };
  const questions = Object.fromEntries(candidates.map((c) => [c.id, {
    type: "score",
    instructions: `How well does the candidate in \`candidates.${c.id}\` meet the criterion in \`criterion\`?`,
    criteria: levels,
  }]));
  return withRisk({ state, questions }, args);
}
function rankResult(result, args) {
  if (!isPlainObject(result)) return result;
  const order = args.candidates.map((c) => c.id);
  const answers = isPlainObject(result.answers) ? result.answers : {};
  const isOk = (id) => answers[id]?.status === "ok" && typeof answers[id].score === "number";
  // ranking[0] is only the best among accepted candidates: if the strongest candidates abstained,
  // it is not the overall best. abstained lists everyone left out, in input order, so a caller can
  // tell the two cases apart before treating ranking[0] as the answer.
  const ranking = order.filter(isOk).sort((a, b) => answers[b].score - answers[a].score);
  const abstained = order.filter((id) => !isOk(id));
  return { ...result, ranking, abstained };
}

function buildDecision(args) {
  if (args.risk === undefined) return { objective: args.objective, context: args.context };
  if (args.context?.risk !== undefined && args.context.risk !== args.risk) invalid("Conflicting risk: top-level risk and context.risk differ");
  return { objective: args.objective, context: { ...args.context, risk: args.risk } };
}

const tools = [
  {
    name: "request_decision",
    description: "Asks the Master-JEV Hook gateway for a choice among real alternatives, a logical evaluation, or evidence-based support. Send objective, criterion and data; the gateway builds the query. The result does not grant permissions nor prove factual truth.",
    inputSchema: { type: "object", additionalProperties: false, required: ["objective", "context"], properties: {
      objective: text8000,
      context: { type: "object", additionalProperties: false, required: ["kind"], properties: {
        kind: { type: "string", enum: ["argumentation", "comparison", "factual", "planning"] },
        criterion: text8000, claim: text8000,
        candidates: { type: "array", minItems: 2, maxItems: 32, items: item },
        evidence: { type: "array", maxItems: 32, items: item },
        risk,
      } },
      risk,
    } },
    path: "/master/context",
    build: buildDecision,
  },
  {
    name: "jev_classify",
    description: "Asks the JEV to classify each item into the best-fitting category, via /master/decide (confidence threshold 0.65/0.80/0.90 by risk low/medium/high; below that the item is left uncategorized).",
    inputSchema: { type: "object", additionalProperties: false, required: ["categories", "items"], properties: {
      purpose: text8000,
      categories: { type: "array", minItems: 2, maxItems: 64, items: item },
      items: { type: "array", minItems: 1, maxItems: 32, items: item },
      risk,
    } },
    path: "/master/decide",
    build: buildClassify,
  },
  {
    name: "jev_verify",
    description: "Asks the JEV for a boolean check on the given state, via /master/decide. The returned Noul is the estimated probability of \"yes\", not a confidence.",
    inputSchema: { type: "object", additionalProperties: false, required: ["question", "state"], properties: {
      question: text8000,
      state: text8000,
      criteria: { type: "object", additionalProperties: false, required: ["true", "false"], properties: { true: text8000, false: text8000 } },
      risk,
    } },
    path: "/master/decide",
    build: buildVerify,
  },
  {
    name: "jev_score",
    description: "Asks the JEV to score one or more criteria on the given state, via /master/decide (confidence threshold 0.65/0.80/0.90 by risk low/medium/high); with weights, the gateway also computes a composite value.",
    inputSchema: { type: "object", additionalProperties: false, required: ["state", "criteria"], properties: {
      state: text8000,
      criteria: { type: "array", minItems: 1, maxItems: 32, items: { type: "object", additionalProperties: false, required: ["id", "question", "levels"], properties: {
        id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" }, question: text8000,
        levels: { type: "array", minItems: 2, maxItems: 10, items: text8000 },
      } } },
      weights: { type: "object", additionalProperties: { type: "number", minimum: 0 }, description: "Optional relative weight per criterion id (non-negative, positive sum); normalized to sum to 1." },
      risk,
    } },
    path: "/master/decide",
    build: buildScore,
  },
  {
    name: "jev_rank",
    description: "Asks the JEV to score candidates against a criterion, via /master/decide (confidence threshold 0.65/0.80/0.90 by risk low/medium/high). Also returns `ranking` (accepted candidate ids ordered by score) and `abstained` (candidate ids left out, in input order). ranking[0] is the best only among accepted candidates: check abstained is empty before treating it as the overall best.",
    inputSchema: { type: "object", additionalProperties: false, required: ["criterion", "candidates"], properties: {
      criterion: text8000,
      candidates: { type: "array", minItems: 2, maxItems: 32, items: item },
      levels: { type: "array", minItems: 2, maxItems: 10, items: text8000 },
      risk,
    } },
    path: "/master/decide",
    build: buildRank,
    postprocess: rankResult,
  },
];

// Standard MCP guidance, including for clients without CLAUDE.md/SessionStart hooks.
const instructions = "When explicit eligible alternatives exist, consult the JEV before deciding: request_decision (objective + context with candidates, criterion, evidence) or, for batches, jev_classify, jev_verify, jev_score and jev_rank. Keep state lean, no secrets; independent questions in a single call. Each request is capped at 64 KB (32 KB for request_decision's context), below the per-field schema maximums: keep items short. State the risk of the action (risk): the gateway requires minimum confidence 0.65 (low), 0.80 (medium) or 0.90 (high) on Choice/Score; Noul is the probability of yes, not a confidence. Abstention or error: local alternative, no retry. Announce with one line before and after each call. The result does not execute actions nor grant permissions.";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const error = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
// Fits the largest call the schemas allow (jev_classify: 96 texts of 8000 chars, up to 3 UTF-8
// bytes each, plus JSON framing); the gateway applies its own, smaller body limit.
const MAX_LINE_BYTES = 4 * 1024 * 1024;
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let message;
  try { message = JSON.parse(line); }
  catch { error(null, -32700, "Invalid JSON request"); continue; }
  // Parsed first so an oversized call still gets an error with its own id.
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) { error(message?.id ?? null, -32600, "Request too large"); continue; }
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") { error(message?.id ?? null, -32600, "Invalid request"); continue; }
  if (message.id === undefined) continue;
  if (message.method === "initialize") {
    const supported = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
    reply(message.id, { protocolVersion: supported.includes(message.params?.protocolVersion) ? message.params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, instructions, serverInfo: { name: "master-jev-hook", version: "1.2.1" } });
  } else if (message.method === "ping") reply(message.id, {});
  // alwaysLoad keeps Claude Code from deferring these tools behind ToolSearch, which cost a turn per consult.
  else if (message.method === "tools/list") reply(message.id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, _meta: { "anthropic/alwaysLoad": true } })) });
  else if (message.method === "tools/call") {
    const toolDef = tools.find((t) => t.name === message.params?.name);
    if (!toolDef) { error(message.id, -32602, "Unknown tool"); continue; }
    let body;
    try { body = toolDef.build(message.params.arguments); }
    catch (e) { error(message.id, e.code ?? -32602, e.message || "Invalid arguments"); continue; }
    try {
      const res = await fetch(new URL(toolDef.path, endpoint), {
        method: "POST", headers: { "content-type": "application/json", ...(process.env.MASTER_JEV_GATEWAY_KEY ? { authorization: `Bearer ${process.env.MASTER_JEV_GATEWAY_KEY}` } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(17000),
      });
      let result = await res.json();
      if (toolDef.postprocess) result = toolDef.postprocess(result, message.params.arguments);
      reply(message.id, { content: [{ type: "text", text: JSON.stringify(result) }], isError: !res.ok || result.status === "fallback" });
    } catch { reply(message.id, { content: [{ type: "text", text: "Gateway unavailable. No decision was applied." }], isError: true }); }
  } else error(message.id, -32601, "Method not found");
}
