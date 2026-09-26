import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { assessContext, appendContextNote, parseDecisionContext } from "../src/context.js";
import { createEventLog } from "../src/events.js";
import { fakeJev, fakeUpstream, settled, testConfig } from "./helpers.js";
import type { AskJev } from "../src/decide.js";

const cfg = () => testConfig({ contextRouting: true, directCalls: false });
const input = { system: "", turns: [{ role: "user", text: "A: Todo mamífero respira; baleia é mamífero; logo respira.\nB: Baleia e peixe vivem na água; logo baleia é peixe.\nQual argumento é válido?" }], tools: [], toolChoice: "auto" as const };
const extension = { kind: "factual", claim: "A amostra tem 12 itens.", evidence: [{ id: "tabela", text: "Contagem da amostra: 12 itens." }] };
const accepted = { evidence: { choice: "sufficient" }, support: { noul: 0.9 } };
function setup(canned: Parameters<typeof fakeJev>[0]) {
  const jev = fakeJev(canned), upstream = fakeUpstream();
  const events = createEventLog();
  const app = createApp({ config: cfg(), askJev: jev.askJev, fetch: upstream.fetchImpl, events });
  const post = (body: object, path = "/v1/chat/completions", headers = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { jev, upstream, events, app, post };
}

describe("context evaluation without tools", () => {
  it("constructs options from explicit labels and does not invent factual probability", async () => {
    const f = fakeJev({ context: { choice: "argumentation" }, selection: { choice: "A" }, logic: { choice: "abstain" } });
    const r = await assessContext(input, undefined, cfg(), f.askJev);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]!.questions.selection).toMatchObject({ criteria: { A: expect.any(String), B: expect.any(String), abstain: expect.any(String) } });
    expect(r).toMatchObject({ status: "partial", calls: 2, inputTokens: 246, assessments: { selection: { choice: "A" }, evidence: { status: "abstain" } } });
    expect(r.assessments.support).toBeUndefined();
  });
  it("gates dependent probability on sufficient supplied evidence", async () => {
    const f = fakeJev(accepted);
    const r = await assessContext(input, parseDecisionContext(extension), cfg(), f.askJev);
    expect(f.requests).toHaveLength(2);
    expect(Object.keys(f.requests[0]!.questions)).toEqual(["evidence"]);
    expect(Object.keys(f.requests[1]!.questions)).toEqual(["support"]);
    expect(r.assessments.support).toMatchObject({ probability: 0.9, interpretation: "supported_by_supplied_evidence" });
    expect(r.assessments.support).not.toHaveProperty("confidence");
  });
  it("never asks Noul after insufficient evidence or low confidence", async () => {
    for (const answer of [{ choice: "insufficient" }, { choice: "sufficient", confidence: 0.3 }]) {
      const f = fakeJev({ evidence: answer });
      const r = await assessContext(input, parseDecisionContext(extension), cfg(), f.askJev);
      expect(f.requests).toHaveLength(1);
      expect(r.assessments.support).toBeUndefined();
    }
  });
  it("abstains when free prose has no explicit comparison candidates", async () => {
    const f = fakeJev({ context: { choice: "comparison" } });
    const r = await assessContext({ ...input, turns: [{ role: "user", text: "Compare as ideias do parágrafo anterior." }] }, undefined, cfg(), f.askJev);
    expect(r).toMatchObject({ status: "abstain", assessments: { selection: { interpretation: "explicit_candidate_ids_required" } } });
  });
  it("rejects malformed, nonfinite, missing and extra answers", async () => {
    for (const answers of [{}, { context: { type: "choice", choice: "factual", confidence: NaN } }, { context: { type: "choice", choice: "injected", confidence: 1 } }, { context: { type: "choice", choice: "other", confidence: 1 }, extra: {} }]) {
      const ask = (async () => ({ model: "invalid-test", answers, usage: { input_tokens: 1, output_tokens: 1 } })) as unknown as AskJev;
      expect(await assessContext(input, undefined, cfg(), ask)).toMatchObject({ status: "fallback", assessments: {} });
    }
  });
  it("applies the risk threshold to supplied decision contexts", async () => {
    const f = fakeJev({ selection: { choice: "A", confidence: 0.85 } });
    const app = createApp({ config: testConfig({ contextRouting: true }), askJev: f.askJev });
    const post = async (risk?: string) => (await (await app.request("/master/context", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Escolha",
      context: { kind: "comparison", criterion: "c", candidates: [{ id: "A", text: "a" }, { id: "B", text: "b" }], ...(risk ? { risk } : {}) } }) })).json()) as any;
    expect(await post()).toMatchObject({ threshold: 0.65, assessments: { selection: { status: "accepted", choice: "A" } } });
    expect(await post("high")).toMatchObject({ threshold: 0.9, assessments: { selection: { status: "abstain" } } });
    expect((await app.request("/master/context", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "x", context: { kind: "comparison", risk: "huge" } }) })).status).toBe(400);
  });

  it("validates harness metadata without silently clipping evidence", () => {
    expect(() => parseDecisionContext({ ...extension, extra: true })).toThrow();
    expect(() => parseDecisionContext({ kind: "comparison", candidates: [{ id: "A", text: "one" }, { id: "A", text: "two" }] })).toThrow();
    expect(() => parseDecisionContext({ kind: "factual", claim: "a".repeat(9000) })).toThrow();
    expect(() => parseDecisionContext({ kind: "argumentation", candidates: [{ id: "abstain", text: "one" }, { id: "B", text: "two" }] })).toThrow();
  });
});

describe("proxy integration", () => {
  it("steers plain text, strips extension, preserves model parameters and records sanitized questions", async () => {
    const s = setup(accepted);
    const body = { model: "test", messages: [{ role: "user", content: "Avalie esta afirmação." }], temperature: 0.1, master_context: extension };
    const res = await s.post(body); await res.text(); await settled();
    expect(res.status).toBe(200);
    const sent = s.upstream.calls[0]!.body;
    expect(sent).not.toHaveProperty("master_context");
    expect(sent).not.toHaveProperty("tool_choice");
    expect(sent.temperature).toBe(0.1);
    expect(sent.messages[0].content).toContain("Master-JEV Hook auxiliary assessment");
    expect(sent.messages[0].content).toContain('"probability":0.9');
    const e = s.events.since(0)[0]!;
    expect(e.context).toMatchObject({ applied: true, calls: 2, status: "accepted" });
    expect(JSON.stringify(e)).not.toContain(extension.evidence[0]!.text);
    expect(e.context!.questions.map((q) => q.id)).toEqual(["evidence", "support"]);
  });
  it("records ordinary text as evaluated but no applicable rule", async () => {
    const s = setup({ context: { choice: "other" } });
    const body = { model: "test", messages: [{ role: "user", content: "Olá" }] };
    await (await s.post(body)).text(); await settled();
    expect(s.upstream.calls[0]!.body).toEqual(body);
    expect(s.events.since(0)[0]!.context).toMatchObject({ status: "skipped", reason: "no_context_rule", calls: 1, applied: false });
  });
  it("honors per-request bypass while stripping internal metadata", async () => {
    const s = setup({});
    const body = { model: "test", messages: [{ role: "user", content: "Olá" }], master_context: extension };
    await (await s.post(body, undefined, { "x-jev-gateway": "off" })).text();
    expect(s.jev.requests).toHaveLength(0);
    expect(s.upstream.calls[0]!.body).toEqual({ model: "test", messages: body.messages });
  });
  it("works for Responses, Messages and Gemini text without tool_choice", async () => {
    for (const [path, body] of [
      ["/v1/responses", { model: "test", input: "Avalie", master_context: extension }],
      ["/v1/messages", { model: "test", max_tokens: 100, messages: [{ role: "user", content: [{ type: "text", text: "Avalie", cache_control: { type: "ephemeral" } }] }], master_context: extension }],
      ["/v1beta/models/test:generateContent", { contents: [{ role: "user", parts: [{ text: "Avalie" }] }], master_context: extension }],
    ] as const) {
      const s = setup(accepted); await (await s.post(body, path)).text();
      const sent = s.upstream.calls[0]!.body;
      expect(JSON.stringify(sent)).toContain("Master-JEV Hook auxiliary assessment");
      expect(sent).not.toHaveProperty("master_context");
      if (path === "/v1/messages") expect(sent.messages[0].content[0]).toEqual(body.messages![0]!.content[0]);
    }
  });
  it("does not pretend to see server-side history", async () => {
    const s = setup({});
    await (await s.post({ model: "test", input: "Continue", previous_response_id: "resp_old" }, "/v1/responses")).text();
    expect(s.jev.requests).toHaveLength(0);
    expect(s.upstream.calls[0]!.body.previous_response_id).toBe("resp_old");
  });
  it("does not overwrite tool-result or assistant tails", () => {
    expect(appendContextNote({ messages: [{ role: "tool", content: "output" }] }, "note")).toBeUndefined();
    expect(appendContextNote({ input: [{ type: "function_call_output", output: "output" }] }, "note")).toBeUndefined();
  });
  it("retries rejected rewrite using clean original without contextual extension", async () => {
    const f = fakeJev(accepted), calls: any[] = [], events = createEventLog();
    const fetch = (async (_: unknown, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return Response.json({}, { status: calls.length === 1 ? 400 : 200 }); }) as typeof globalThis.fetch;
    const app = createApp({ config: cfg(), askJev: f.askJev, fetch, events });
    await (await app.request("/v1/responses", { method: "POST", body: JSON.stringify({ model: "test", input: "Avalie", master_context: extension }) })).text(); await settled();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ model: "test", input: "Avalie" });
    expect(events.since(0)[0]!.context).toMatchObject({ applied: false, reason: "upstream_rejected_rewrite" });
  });
  it("preserves SSE without buffering it into a synthesized answer", async () => {
    const f = fakeJev(accepted), chunk = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
    const app = createApp({ config: cfg(), askJev: f.askJev, fetch: (async () => new Response(chunk, { headers: { "content-type": "text/event-stream" } })) as typeof fetch });
    const res = await app.request("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "test", stream: true, messages: [{ role: "user", content: "Avalie" }], master_context: extension }) });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(chunk);
  });
  it("fails open after JEV failure without leaking exception content", async () => {
    const up = fakeUpstream(), events = createEventLog();
    const app = createApp({ config: cfg(), askJev: async () => { throw new Error("secret-token"); }, fetch: up.fetchImpl, events });
    const body = { model: "test", messages: [{ role: "user", content: "Avalie" }] };
    await (await app.request("/v1/chat/completions", { method: "POST", body: JSON.stringify(body) })).text(); await settled();
    expect(up.calls[0]!.body).toEqual(body);
    expect(JSON.stringify(events.since(0))).not.toContain("secret-token");
    expect(events.since(0)[0]!.context?.status).toBe("fallback");
  });
});
