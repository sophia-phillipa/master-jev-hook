import { createServer, type RequestListener } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { fakeJev, testConfig } from "./helpers.js";

it("context endpoint creates questions and returns a decision without upstream", async () => {
  const f = fakeJev({ selection: { choice: "A" } });
  const app = createApp({ config: testConfig({ contextRouting: true }), askJev: f.askJev, fetch: async () => { throw new Error("must not call LLM"); } });
  const res = await app.request("/master/context", { method: "POST", body: JSON.stringify({ objective: "Escolha a fonte primária", context: { kind: "comparison", criterion: "Fonte primária", candidates: [{ id: "A", text: "Manual do fabricante" }, { id: "B", text: "Comentário sem fonte" }] } }) });
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
  const args = { objective: "Escolha", context: { kind: "comparison", candidates: [{ id: "A", text: "a" }, { id: "B", text: "b" }] } };
  const rows = await runAdapter(gw.handler, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "solicitar_decisao", arguments: args } },
  ]);
  expect(rows[0].result.instructions).toContain("solicitar_decisao");
  expect(rows[0].result.instructions).toContain("sem retry");
  const names = rows[1].result.tools.map((t: any) => t.name);
  expect(names).toEqual(["solicitar_decisao", "jev_classificar", "jev_verificar", "jev_pontuar", "jev_ranquear"]);
  expect(rows[2].result.isError).toBe(false);
  expect(gw.received).toEqual({ path: "/master/context", body: args });
});

it("jev_classificar builds one choice question per item, with the purpose folded into the instructions", async () => {
  const gw = fakeGateway({ status: "ok", answers: {}, stages: [], calls: 1, inputTokens: 0, outputTokens: 0, latencyMs: 1 });
  const args = {
    finalidade: "Selecionar prioridade",
    categorias: [{ id: "alta", text: "Alta prioridade" }, { id: "baixa", text: "Baixa prioridade" }],
    itens: [{ id: "tarefa1", text: "Corrigir bug critico" }],
  };
  const rows = await runAdapter(gw.handler, [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_classificar", arguments: args } },
  ]);
  expect(rows[0].result.isError).toBe(false);
  expect(gw.received.path).toBe("/master/decide");
  expect(gw.received.body).toEqual({
    state: { finalidade: "Selecionar prioridade", itens: { tarefa1: "Corrigir bug critico" } },
    questions: {
      tarefa1: {
        type: "choice",
        instructions: "Classify the item in `itens.tarefa1` into the best-fitting category. Purpose (see `finalidade`): Selecionar prioridade.",
        criteria: { alta: "Alta prioridade", baixa: "Baixa prioridade" },
      },
    },
  });
});

it("jev_classificar without finalidade omits it from state and instructions", async () => {
  const gw = fakeGateway({ status: "ok", answers: {}, stages: [], calls: 1, inputTokens: 0, outputTokens: 0, latencyMs: 1 });
  const args = {
    categorias: [{ id: "a", text: "Categoria A" }, { id: "b", text: "Categoria B" }],
    itens: [{ id: "x", text: "Item X" }],
  };
  await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_classificar", arguments: args } }]);
  expect(gw.received.body).toEqual({
    state: { itens: { x: "Item X" } },
    questions: { x: { type: "choice", instructions: "Classify the item in `itens.x` into the best-fitting category.", criteria: { a: "Categoria A", b: "Categoria B" } } },
  });
});

it("jev_verificar builds a single noul question, optionally with criteria", async () => {
  const gw = fakeGateway({ status: "ok", answers: { verificacao: { type: "noul", status: "ok", noul: 0.8 } }, stages: [], calls: 1, inputTokens: 0, outputTokens: 0, latencyMs: 1 });
  const args = { pergunta: "O item parece duplicado?", estado: "Item: recibo #123, valor R$50", criterios: { true: "Claramente duplicado", false: "Não há indício de duplicidade" } };
  const rows = await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_verificar", arguments: args } }]);
  expect(rows[0].result.isError).toBe(false);
  expect(gw.received).toEqual({
    path: "/master/decide",
    body: { state: "Item: recibo #123, valor R$50", questions: { verificacao: { type: "noul", instructions: "O item parece duplicado?", criteria: { true: "Claramente duplicado", false: "Não há indício de duplicidade" } } } },
  });
});

it("jev_verificar without criterios omits the criteria field", async () => {
  const gw = fakeGateway({ status: "ok", answers: { verificacao: { type: "noul", status: "ok", noul: 0.2 } }, stages: [], calls: 1, inputTokens: 0, outputTokens: 0, latencyMs: 1 });
  const args = { pergunta: "Está correto?", estado: "estado simples" };
  await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_verificar", arguments: args } }]);
  expect(gw.received.body).toEqual({ state: "estado simples", questions: { verificacao: { type: "noul", instructions: "Está correto?" } } });
});

it("jev_pontuar builds one score question per criterio and forwards pesos as composite", async () => {
  const gw = fakeGateway({ status: "ok", answers: {}, stages: [], calls: 1, inputTokens: 0, outputTokens: 0, latencyMs: 1 });
  const args = {
    estado: "Proposta X",
    criterios: [
      { id: "clareza", pergunta: "Quão clara é a proposta?", niveis: ["baixa", "média", "alta"] },
      { id: "viabilidade", pergunta: "Quão viável é a proposta?", niveis: ["baixa", "média", "alta"] },
    ],
    pesos: { clareza: 0.4, viabilidade: 0.6 },
  };
  const rows = await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_pontuar", arguments: args } }]);
  expect(rows[0].result.isError).toBe(false);
  expect(gw.received.body).toEqual({
    state: "Proposta X",
    questions: {
      clareza: { type: "score", instructions: "Quão clara é a proposta?", criteria: ["baixa", "média", "alta"] },
      viabilidade: { type: "score", instructions: "Quão viável é a proposta?", criteria: ["baixa", "média", "alta"] },
    },
    composite: { clareza: 0.4, viabilidade: 0.6 },
  });
});

it("jev_pontuar without pesos omits the composite field", async () => {
  const gw = fakeGateway({ status: "ok", answers: {}, stages: [], calls: 1, inputTokens: 0, outputTokens: 0, latencyMs: 1 });
  const args = { estado: "Proposta Y", criterios: [{ id: "risco", pergunta: "Qual o risco?", niveis: ["baixo", "alto"] }] };
  await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_pontuar", arguments: args } }]);
  expect(gw.received.body).toEqual({ state: "Proposta Y", questions: { risco: { type: "score", instructions: "Qual o risco?", criteria: ["baixo", "alto"] } } });
});

it("jev_ranquear builds one score question per candidate and adds a ranking sorted by score, ignoring non-ok answers", async () => {
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
    criterio: "Melhor custo-benefício",
    candidatos: [{ id: "a", text: "Fornecedor A" }, { id: "b", text: "Fornecedor B" }, { id: "c", text: "Fornecedor C" }, { id: "d", text: "Fornecedor D" }],
  };
  const rows = await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_ranquear", arguments: args } }]);
  expect(rows[0].result.isError).toBe(false);
  expect(gw.received.body).toEqual({
    state: { criterio: "Melhor custo-benefício", candidatos: { a: "Fornecedor A", b: "Fornecedor B", c: "Fornecedor C", d: "Fornecedor D" } },
    questions: {
      a: { type: "score", instructions: "How well does the candidate in `candidatos.a` meet the criterion in `criterio`?", criteria: ["Does not meet the criterion", "Weak fit", "Adequate fit", "Good fit", "Excellent fit"] },
      b: { type: "score", instructions: "How well does the candidate in `candidatos.b` meet the criterion in `criterio`?", criteria: ["Does not meet the criterion", "Weak fit", "Adequate fit", "Good fit", "Excellent fit"] },
      c: { type: "score", instructions: "How well does the candidate in `candidatos.c` meet the criterion in `criterio`?", criteria: ["Does not meet the criterion", "Weak fit", "Adequate fit", "Good fit", "Excellent fit"] },
      d: { type: "score", instructions: "How well does the candidate in `candidatos.d` meet the criterion in `criterio`?", criteria: ["Does not meet the criterion", "Weak fit", "Adequate fit", "Good fit", "Excellent fit"] },
    },
  });
  const payload = JSON.parse(rows[0].result.content[0].text);
  expect(payload.ranking).toEqual(["b", "c", "a"]);
});

it("jev_ranquear accepts custom niveis", async () => {
  const gw = fakeGateway({ status: "ok", answers: { a: { type: "score", status: "ok", score: 0, confidence: 0.9 }, b: { type: "score", status: "ok", score: 1, confidence: 0.9 } }, stages: [], calls: 1, inputTokens: 0, outputTokens: 0, latencyMs: 1 });
  const args = { criterio: "C", candidatos: [{ id: "a", text: "A" }, { id: "b", text: "B" }], niveis: ["não", "sim"] };
  await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_ranquear", arguments: args } }]);
  expect(gw.received.body.questions.a.criteria).toEqual(["não", "sim"]);
});

it("risco maps to the gateway risk level on every lote tool, and solicitar_decisao forwards context.risk", async () => {
  const cases: [string, Record<string, unknown>][] = [
    ["jev_verificar", { pergunta: "p", estado: "e" }],
    ["jev_classificar", { categorias: [{ id: "a", text: "A" }, { id: "b", text: "B" }], itens: [{ id: "x", text: "X" }] }],
    ["jev_pontuar", { estado: "e", criterios: [{ id: "c", pergunta: "p", niveis: ["baixo", "alto"] }] }],
    ["jev_ranquear", { criterio: "c", candidatos: [{ id: "a", text: "A" }, { id: "b", text: "B" }] }],
  ];
  for (const [name, args] of cases) {
    for (const [risco, risk] of [["baixo", "low"], ["medio", "medium"], ["alto", "high"]]) {
      const gw = fakeGateway({ status: "ok", answers: {} });
      await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { ...args, risco } } }]);
      expect(gw.received.body.risk, name).toBe(risk);
    }
    const gw = fakeGateway({ status: "ok", answers: {} });
    await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }]);
    expect(gw.received.body, name).not.toHaveProperty("risk");
  }
  const gw = fakeGateway();
  const args = { objective: "o", context: { kind: "comparison", risk: "high", candidates: [{ id: "A", text: "a" }, { id: "B", text: "b" }] } };
  await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "solicitar_decisao", arguments: args } }]);
  expect(gw.received.body).toEqual(args);
  const rejected = fakeGateway();
  const rows = await runAdapter(rejected.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_verificar", arguments: { pergunta: "p", estado: "e", risco: "extremo" } } }]);
  expect(JSON.stringify(rows)).toContain("-32602");
  expect(rejected.received).toBeUndefined();
});

describe("adapter-side rejection of malformed arguments (-32602, no gateway call)", () => {
  it("rejects jev_classificar with fewer than 2 categorias", async () => {
    const gw = fakeGateway();
    const args = { categorias: [{ id: "only", text: "one" }], itens: [{ id: "x", text: "x" }] };
    const rows = await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_classificar", arguments: args } }]);
    expect(rows[0].error?.code).toBe(-32602);
    expect(rows[0].result).toBeUndefined();
    expect(gw.received).toBeUndefined();
  });

  it("rejects jev_verificar missing the false criterio", async () => {
    const gw = fakeGateway();
    const args = { pergunta: "P?", estado: "e", criterios: { true: "sim" } };
    const rows = await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_verificar", arguments: args } }]);
    expect(rows[0].error?.code).toBe(-32602);
    expect(gw.received).toBeUndefined();
  });

  it("rejects jev_pontuar when pesos references an id that isn't a criterio", async () => {
    const gw = fakeGateway();
    const args = { estado: "e", criterios: [{ id: "a", pergunta: "p", niveis: ["x", "y"] }], pesos: { a: 0.5, b: 0.5 } };
    const rows = await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_pontuar", arguments: args } }]);
    expect(rows[0].error?.code).toBe(-32602);
    expect(gw.received).toBeUndefined();
  });

  it("rejects jev_ranquear with duplicate candidate ids", async () => {
    const gw = fakeGateway();
    const args = { criterio: "c", candidatos: [{ id: "a", text: "1" }, { id: "a", text: "2" }] };
    const rows = await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_ranquear", arguments: args } }]);
    expect(rows[0].error?.code).toBe(-32602);
    expect(gw.received).toBeUndefined();
  });

  it("rejects an invalid item id pattern", async () => {
    const gw = fakeGateway();
    const args = { criterio: "c", candidatos: [{ id: "bad id!", text: "1" }, { id: "ok", text: "2" }] };
    const rows = await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_ranquear", arguments: args } }]);
    expect(rows[0].error?.code).toBe(-32602);
    expect(gw.received).toBeUndefined();
  });
});

it("surfaces isError true when the gateway falls back on an invalid workflow", async () => {
  const gw = fakeGateway({ status: "fallback", reason: "invalid_workflow" }, 400);
  const args = { estado: "e", criterios: [{ id: "a", pergunta: "p", niveis: ["x", "y"] }] };
  const rows = await runAdapter(gw.handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "jev_pontuar", arguments: args } }]);
  expect(rows[0].result.isError).toBe(true);
  const payload = JSON.parse(rows[0].result.content[0].text);
  expect(payload).toEqual({ status: "fallback", reason: "invalid_workflow" });
});
