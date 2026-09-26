import { createServer, type RequestListener } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fakeJev, testConfig } from "./helpers.js";

it("context endpoint creates questions and returns a decision without upstream", async () => {
  const f = fakeJev({ selection: { choice: "A" } });
  const app = createApp({ config: testConfig({ contextRouting: true }), askJev: f.askJev, fetch: async () => { throw new Error("must not call LLM"); } });
  const res = await app.request("/master/context", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Choose the primary source", context: { kind: "comparison", criterion: "Primary source", candidates: [{ id: "A", text: "Manufacturer's manual" }, { id: "B", text: "Comment without a source" }] } }) });
  expect(res.status).toBe(200); expect((await res.json() as any).assessments.selection.choice).toBe("A"); expect(f.requests).toHaveLength(1);
});

/** Spins a fake HTTP gateway and pipes JSON-RPC lines into the stdio adapter, returning its stdout rows. */
async function runAdapter(handler: RequestListener, calls: unknown[]) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as any).port;
  const child = spawn(process.execPath, [new URL("../bin/master-jev-mcp.mjs", import.meta.url).pathname], { env: { ...process.env, MASTER_JEV_GATEWAY_URL: `http://127.0.0.1:${port}` }, stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", (b) => output += b); let err = ""; child.stderr.on("data", (b) => err += b);
  child.stdin.end(calls.map((x) => JSON.stringify(x)).join("\n") + "\n");
  try {
    const [code] = await once(child, "exit");
    expect(code, err).toBe(0);
    const rows = output.trim().length ? output.trim().split("\n").map((x) => JSON.parse(x)) : [];
    return rows;
  } finally { child.kill(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

/** A fake gateway that records the single request it receives and echoes a fixed reply. */
function fakeGateway(reply: unknown = { status: "accepted", assessments: { selection: { choice: "A" } } }, status = 200) {
  let received: any;
  const handler: RequestListener = async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    received = { path: req.url, body: JSON.parse(body) };
    res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(reply));
  };
  return { handler, get received() { return received; } };
}

it("MCP exposes the tool and forwards only its structured arguments", async () => {
  const gw = fakeGateway();
  const args = { objective: "Choice", context: { kind: "comparison", candidates: [{ id: "A", text: "a" }, { id: "B", text: "b" }] } };
  const rows = await runAdapter(gw.handler, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "request_decision", arguments: args } },
  ]);
  expect(rows[0].result.instructions).toContain("request_decision");
  expect(rows[0].result.instructions).toContain("no retry");
  const names = rows[1].result.tools.map((t: any) => t.name);
  expect(names).toEqual(["request_decision", "jev_classify", "jev_verify", "jev_score", "jev_rank"]);
  expect(rows[2].result.isError).toBe(false);
  expect(gw.received).toEqual({ path: "/master/context", body: args });
});

it("jev_classify builds one choice question per item, with the purpose folded into the instructions", async () => {
  const gw = fakeGateway({ status: "ok", answers: {}, stages: [], calls: 1, inputTokens: 0, outputTokens: 0, latencyMs: 1 });
  const args = {
    purpose: "Select priority",
    categories: [{ id: "high", text: "High priority" }, { id: "low", text: "Low priority" }],
    items: [{ id: "task1", text: "Fix critical bug" }],
  };
  const rows = await runAdapter(gw.handler, [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_classify", arguments: args } },
  ]);
  expect(rows[0].result.isError).toBe(false);
  expect(gw.received.path).toBe("/master/decide");
  expect(gw.received.body).toEqual({
    state: { purpose: "Select priority", items: { task1: "Fix critical bug" } },
    questions: {
      task1: {
        type: "choice",
        instructions: "Classify the item in `items.task1` into the best-fitting category. Purpose (see `purpose`): Select priority.",
        criteria: { high: "High priority", low: "Low priority" },
      },
    },
  });
});

it("jev_classify without purpose omits it from state and instructions", async () => {
  const gw = fakeGateway({ status: "ok", answers: {}, stages: [], calls: 1, inputTokens: 0, outputTokens: 0, latencyMs: 1 });
  const args = {
    categories: [{ id: "a", text: "Category A" }, { id: "b", text: "Category B" }],
    items: [{ id: "x", text: "Item X" }],
  };
  await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_classify", arguments: args } }]);
  expect(gw.received.body).toEqual({
    state: { items: { x: "Item X" } },
    questions: { x: { type: "choice", instructions: "Classify the item in `items.x` into the best-fitting category.", criteria: { a: "Category A", b: "Category B" } } },
  });
});

it("jev_verify builds a single noul question, optionally with criteria", async () => {
  const gw = fakeGateway({ status: "ok", answers: { verification: { type: "noul", status: "ok", noul: 0.8 } }, stages: [], calls: 1, inputTokens: 0, outputTokens: 0, latencyMs: 1 });
  const args = { question: "Does the item look duplicated?", state: "Item: receipt #123, amount $50", criteria: { true: "Clearly duplicated", false: "No indication of duplication" } };
  const rows = await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_verify", arguments: args } }]);
  expect(rows[0].result.isError).toBe(false);
  expect(gw.received).toEqual({
    path: "/master/decide",
    body: { state: "Item: receipt #123, amount $50", questions: { verification: { type: "noul", instructions: "Does the item look duplicated?", criteria: { true: "Clearly duplicated", false: "No indication of duplication" } } } },
  });
});

it("jev_verify without criteria omits the criteria field", async () => {
  const gw = fakeGateway({ status: "ok", answers: { verification: { type: "noul", status: "ok", noul: 0.2 } }, stages: [], calls: 1, inputTokens: 0, outputTokens: 0, latencyMs: 1 });
  const args = { question: "Is it correct?", state: "simple state" };
  await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_verify", arguments: args } }]);
  expect(gw.received.body).toEqual({ state: "simple state", questions: { verification: { type: "noul", instructions: "Is it correct?" } } });
});

it("jev_score builds one score question per criterion and forwards weights as composite", async () => {
  const gw = fakeGateway({ status: "ok", answers: {}, stages: [], calls: 1, inputTokens: 0, outputTokens: 0, latencyMs: 1 });
  const args = {
    state: "Proposal X",
    criteria: [
      { id: "clarity", question: "How clear is the proposal?", levels: ["low", "medium", "high"] },
      { id: "feasibility", question: "How feasible is the proposal?", levels: ["low", "medium", "high"] },
    ],
    weights: { clarity: 0.4, feasibility: 0.6 },
  };
  const rows = await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_score", arguments: args } }]);
  expect(rows[0].result.isError).toBe(false);
  expect(gw.received.body).toEqual({
    state: "Proposal X",
    questions: {
      clarity: { type: "score", instructions: "How clear is the proposal?", criteria: ["low", "medium", "high"] },
      feasibility: { type: "score", instructions: "How feasible is the proposal?", criteria: ["low", "medium", "high"] },
    },
    composite: { clarity: 0.4, feasibility: 0.6 },
  });
});

it("jev_score normalizes relative weights so the gateway accepts them", async () => {
  const gw = fakeGateway({ status: "ok", answers: {}, stages: [], calls: 1, inputTokens: 0, outputTokens: 0, latencyMs: 1 });
  const criteria = [{ id: "a", question: "q", levels: ["l", "h"] }, { id: "b", question: "q", levels: ["l", "h"] }];
  const rows = await runAdapter(gw.handler, [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_score", arguments: { state: "s", criteria, weights: { a: 2, b: 0 } } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jev_score", arguments: { state: "s", criteria, weights: { a: 0, b: 0 } } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "jev_score", arguments: { state: "s", criteria, weights: { a: -1, b: 2 } } } },
  ]);
  expect(rows[0].result.isError).toBe(false);
  expect(gw.received.body.composite).toEqual({ a: 1, b: 0 });
  expect(rows[1].error?.code).toBe(-32602);
  expect(rows[2].error?.code).toBe(-32602);
});

it("answers an oversized line with an error that carries its id", async () => {
  const gw = fakeGateway();
  const big = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "jev_verify", arguments: { question: "q", state: "x".repeat(5 * 1024 * 1024) } } };
  const rows = await runAdapter(gw.handler, [big]);
  expect(rows[0]).toMatchObject({ id: 7, error: { code: -32600 } });
  expect(gw.received).toBeUndefined();
});

it("jev_score without weights omits the composite field", async () => {
  const gw = fakeGateway({ status: "ok", answers: {}, stages: [], calls: 1, inputTokens: 0, outputTokens: 0, latencyMs: 1 });
  const args = { state: "Proposal Y", criteria: [{ id: "risk_level", question: "What is the risk?", levels: ["low", "high"] }] };
  await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_score", arguments: args } }]);
  expect(gw.received.body).toEqual({ state: "Proposal Y", questions: { risk_level: { type: "score", instructions: "What is the risk?", criteria: ["low", "high"] } } });
});

it("jev_rank builds one score question per candidate and adds a ranking sorted by score, ignoring non-ok answers", async () => {
  const gw = fakeGateway({
    status: "partial",
    answers: {
      a: { type: "score", status: "ok", score: 1, confidence: 0.9 },
      b: { type: "score", status: "ok", score: 3, confidence: 0.9 },
      c: { type: "score", status: "ok", score: 3, confidence: 0.9 },
      d: { type: "score", status: "abstain", score: null, confidence: 0.5 },
    },
    stages: [], calls: 1, inputTokens: 0, outputTokens: 0, latencyMs: 1,
  });
  const args = {
    criterion: "Best cost-benefit",
    candidates: [{ id: "a", text: "Supplier A" }, { id: "b", text: "Supplier B" }, { id: "c", text: "Supplier C" }, { id: "d", text: "Supplier D" }],
  };
  const rows = await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_rank", arguments: args } }]);
  expect(rows[0].result.isError).toBe(false);
  expect(gw.received.body).toEqual({
    state: { criterion: "Best cost-benefit", candidates: { a: "Supplier A", b: "Supplier B", c: "Supplier C", d: "Supplier D" } },
    questions: {
      a: { type: "score", instructions: "How well does the candidate in `candidates.a` meet the criterion in `criterion`?", criteria: ["Does not meet the criterion", "Weak fit", "Adequate fit", "Good fit", "Excellent fit"] },
      b: { type: "score", instructions: "How well does the candidate in `candidates.b` meet the criterion in `criterion`?", criteria: ["Does not meet the criterion", "Weak fit", "Adequate fit", "Good fit", "Excellent fit"] },
      c: { type: "score", instructions: "How well does the candidate in `candidates.c` meet the criterion in `criterion`?", criteria: ["Does not meet the criterion", "Weak fit", "Adequate fit", "Good fit", "Excellent fit"] },
      d: { type: "score", instructions: "How well does the candidate in `candidates.d` meet the criterion in `criterion`?", criteria: ["Does not meet the criterion", "Weak fit", "Adequate fit", "Good fit", "Excellent fit"] },
    },
  });
  const payload = JSON.parse(rows[0].result.content[0].text);
  expect(payload.ranking).toEqual(["b", "c", "a"]);
  expect(payload.abstained).toEqual(["d"]);
});

it("jev_rank lists abstained candidates in input order so a caller can spot a bad ranking[0]", async () => {
  // All the strong candidates abstain; only the weak one is accepted. ranking[0] is still "weak"
  // (the best among accepted candidates), but a non-empty `abstained` warns it is not the overall best.
  const gw = fakeGateway({
    status: "partial",
    answers: {
      strong1: { type: "score", status: "abstain", score: null, confidence: 0.5 },
      strong2: { type: "score", status: "abstain", score: null, confidence: 0.5 },
      weak: { type: "score", status: "ok", score: 0, confidence: 0.9 },
    },
    stages: [], calls: 1, inputTokens: 0, outputTokens: 0, latencyMs: 1,
  });
  const args = {
    criterion: "Best fit",
    candidates: [{ id: "strong1", text: "Strong 1" }, { id: "strong2", text: "Strong 2" }, { id: "weak", text: "Weak" }],
  };
  const rows = await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_rank", arguments: args } }]);
  const payload = JSON.parse(rows[0].result.content[0].text);
  expect(payload.ranking).toEqual(["weak"]);
  expect(payload.abstained).toEqual(["strong1", "strong2"]);
});

it("jev_rank accepts custom levels", async () => {
  const gw = fakeGateway({ status: "ok", answers: { a: { type: "score", status: "ok", score: 0, confidence: 0.9 }, b: { type: "score", status: "ok", score: 1, confidence: 0.9 } }, stages: [], calls: 1, inputTokens: 0, outputTokens: 0, latencyMs: 1 });
  const args = { criterion: "C", candidates: [{ id: "a", text: "A" }, { id: "b", text: "B" }], levels: ["no", "yes"] };
  await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_rank", arguments: args } }]);
  expect(gw.received.body.questions.a.criteria).toEqual(["no", "yes"]);
});

it("risk maps to the gateway risk level on every batch tool, and request_decision forwards context.risk", async () => {
  const cases: [string, Record<string, unknown>][] = [
    ["jev_verify", { question: "p", state: "e" }],
    ["jev_classify", { categories: [{ id: "a", text: "A" }, { id: "b", text: "B" }], items: [{ id: "x", text: "X" }] }],
    ["jev_score", { state: "e", criteria: [{ id: "c", question: "p", levels: ["low", "high"] }] }],
    ["jev_rank", { criterion: "c", candidates: [{ id: "a", text: "A" }, { id: "b", text: "B" }] }],
  ];
  for (const [name, args] of cases) {
    for (const risk of ["low", "medium", "high"]) {
      const gw = fakeGateway({ status: "ok", answers: {} });
      await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { ...args, risk } } }]);
      expect(gw.received.body.risk, name).toBe(risk);
    }
    const gw = fakeGateway({ status: "ok", answers: {} });
    await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }]);
    expect(gw.received.body, name).not.toHaveProperty("risk");
  }
  const gw = fakeGateway();
  const args = { objective: "o", context: { kind: "comparison", risk: "high", candidates: [{ id: "A", text: "a" }, { id: "B", text: "b" }] } };
  await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "request_decision", arguments: args } }]);
  expect(gw.received.body).toEqual(args);
  const rejected = fakeGateway();
  const rows = await runAdapter(rejected.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_verify", arguments: { question: "p", state: "e", risk: "extreme" } } }]);
  expect(JSON.stringify(rows)).toContain("-32602");
  expect(rejected.received).toBeUndefined();
});

it("request_decision accepts a top-level risk and moves it into context.risk", async () => {
  const gw = fakeGateway();
  const args = { objective: "o", context: { kind: "comparison", candidates: [{ id: "A", text: "a" }, { id: "B", text: "b" }] }, risk: "high" };
  await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "request_decision", arguments: args } }]);
  expect(gw.received.body).toEqual({ objective: "o", context: { kind: "comparison", candidates: [{ id: "A", text: "a" }, { id: "B", text: "b" }], risk: "high" } });
});

it("request_decision rejects a top-level risk that conflicts with context.risk", async () => {
  const rejected = fakeGateway();
  const args = { objective: "o", context: { kind: "comparison", risk: "low", candidates: [{ id: "A", text: "a" }, { id: "B", text: "b" }] }, risk: "high" };
  const rows = await runAdapter(rejected.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "request_decision", arguments: args } }]);
  expect(JSON.stringify(rows)).toContain("-32602");
  expect(rejected.received).toBeUndefined();
});

describe("adapter-side rejection of malformed arguments (-32602, no gateway call)", () => {
  it("rejects jev_classify with fewer than 2 categories", async () => {
    const gw = fakeGateway();
    const args = { categories: [{ id: "only", text: "one" }], items: [{ id: "x", text: "x" }] };
    const rows = await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_classify", arguments: args } }]);
    expect(rows[0].error?.code).toBe(-32602);
    expect(rows[0].result).toBeUndefined();
    expect(gw.received).toBeUndefined();
  });

  it("rejects jev_verify missing the false criterion", async () => {
    const gw = fakeGateway();
    const args = { question: "P?", state: "e", criteria: { true: "yes" } };
    const rows = await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_verify", arguments: args } }]);
    expect(rows[0].error?.code).toBe(-32602);
    expect(gw.received).toBeUndefined();
  });

  it("rejects jev_score when weights references an id that isn't a criterion", async () => {
    const gw = fakeGateway();
    const args = { state: "e", criteria: [{ id: "a", question: "p", levels: ["x", "y"] }], weights: { a: 0.5, b: 0.5 } };
    const rows = await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_score", arguments: args } }]);
    expect(rows[0].error?.code).toBe(-32602);
    expect(gw.received).toBeUndefined();
  });

  it("rejects jev_rank with duplicate candidate ids", async () => {
    const gw = fakeGateway();
    const args = { criterion: "c", candidates: [{ id: "a", text: "1" }, { id: "a", text: "2" }] };
    const rows = await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_rank", arguments: args } }]);
    expect(rows[0].error?.code).toBe(-32602);
    expect(gw.received).toBeUndefined();
  });

  it("rejects an invalid item id pattern", async () => {
    const gw = fakeGateway();
    const args = { criterion: "c", candidates: [{ id: "bad id!", text: "1" }, { id: "ok", text: "2" }] };
    const rows = await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_rank", arguments: args } }]);
    expect(rows[0].error?.code).toBe(-32602);
    expect(gw.received).toBeUndefined();
  });
});

it("surfaces isError true when the gateway falls back on an invalid workflow", async () => {
  const gw = fakeGateway({ status: "fallback", reason: "invalid_workflow" }, 400);
  const args = { state: "e", criteria: [{ id: "a", question: "p", levels: ["x", "y"] }] };
  const rows = await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_score", arguments: args } }]);
  expect(rows[0].result.isError).toBe(true);
  const payload = JSON.parse(rows[0].result.content[0].text);
  expect(payload).toEqual({ status: "fallback", reason: "invalid_workflow" });
});
