import { describe, expect, it } from "vitest";
import type { AskJev } from "../src/decide.js";
import { parseWorkflow, runWorkflow } from "../src/workflow.js";
import { createApp } from "../src/app.js";
import { fakeUpstream, testConfig, settled } from "./helpers.js";
import { createEventLog } from "../src/events.js";

const gate = { type: "choice", instructions: "Is there enough evidence?", criteria: { yes: "Yes", no: "No" } };
const score = { type: "score", instructions: "Quality on this dimension", criteria: ["low", "medium", "high"] };
const chain = { state: { evidence: "example" }, stages: [
  { id: "gate", questions: { enough: gate } },
  { id: "evaluate", when: { question: "enough", equals: "yes" }, questions: { logic: score, support: score, risk: { type: "noul", instructions: "Is there an error?" } } },
], composite: { logic: 0.4, support: 0.6 }, cascade: { questions: ["risk"], accept_below: 0.2, escalate_at: 0.8 } };
function fake(yes = "yes", confidence = 0.9, risk = 0.2) {
  const calls: any[] = [];
  const ask: AskJev = async (request) => {
    calls.push(request);
    return { model: "test", usage: { input_tokens: 10, output_tokens: 5 }, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id,
      q.type === "choice" ? { type: "choice", choice: yes, confidence: 0.9, probabilities: { [yes]: 1 } }
        : q.type === "score" ? { type: "score", score: id === "logic" ? 2 : 1, confidence: id === "logic" ? 0.95 : confidence }
        : { type: "noul", noul: risk },
    ])) } as any;
  };
  return { ask, calls };
}

describe("risk-scaled thresholds", () => {
  const single = (risk?: string) => ({ state: "s", questions: { q: score }, ...(risk ? { risk } : {}) });
  it("accepts only low, medium or high risk", () => {
    for (const risk of ["low", "medium", "high"]) expect(parseWorkflow(single(risk)).risk).toBe(risk);
    for (const risk of ["extreme", "", 1]) expect(() => parseWorkflow({ ...single(), risk })).toThrow("invalid_workflow");
  });
  it("applies the stricter threshold and reports it", async () => {
    const f = fake("yes", 0.85);
    const low = await runWorkflow(parseWorkflow(single()), f.ask, "test", 0.65);
    expect(low).toMatchObject({ status: "ok", threshold: 0.65 });
    const high = await runWorkflow(parseWorkflow(single("high")), f.ask, "test", 0.9);
    expect(high).toMatchObject({ status: "abstain", threshold: 0.9 });
    expect(high.answers.q).toMatchObject({ status: "abstain", score: null, confidence: 0.85 });
  });
  it("maps risk to configured thresholds that never fall below the floor", async () => {
    const f = fake("yes", 0.85);
    const app = createApp({ config: testConfig(), askJev: f.ask });
    const post = async (risk: string) => (await (await app.request("/master/decide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(single(risk)) })).json()) as any;
    expect(await post("medium")).toMatchObject({ status: "ok", threshold: 0.8 });
    expect(await post("high")).toMatchObject({ status: "abstain", threshold: 0.9 });
    const { loadConfig } = await import("../src/config.js");
    expect(loadConfig({ JEV_MIN_CONFIDENCE: "0.85" }).riskThresholds).toEqual({ low: 0.85, medium: 0.85, high: 0.9 });
    expect(() => loadConfig({ JEV_MIN_CONFIDENCE_HIGH: "1.5" })).toThrow();
  });
});

describe("batches, chains, composite and cascade", () => {
  it("batches independent questions and waits for dependent stages", async () => {
    const f = fake(), r = await runWorkflow(parseWorkflow(chain), f.ask, "test", 0.65);
    expect(f.calls).toHaveLength(2);
    expect(Object.keys(f.calls[1].questions)).toEqual(["logic", "support", "risk"]);
    expect(f.calls[1].state.previous_answers.enough.choice).toBe("yes");
    expect(r.composite).toEqual({ status: "ok", value: 0.7, weights: { logic: 0.4, support: 0.6 } });
    expect(r.cascade).toEqual({ route: "review", max_error_probability: 0.2 });
    expect(r).toMatchObject({ calls: 2, inputTokens: 20, outputTokens: 10 });
  });
  it("skips conditional questions without charging another call or substituting zero", async () => {
    const f = fake("no"), r = await runWorkflow(parseWorkflow(chain), f.ask, "test", 0.65);
    expect(f.calls).toHaveLength(1);
    expect(r.stages[1]?.status).toBe("skipped");
    expect(r.answers.logic?.status).toBe("skipped");
    expect(r.composite).toMatchObject({ status: "abstain", value: null });
    expect(r.cascade?.route).toBe("abstain");
  });
  it("invalidates composite after one low-confidence score", async () => {
    const f = fake("yes", 0.4), r = await runWorkflow(parseWorkflow(chain), f.ask, "test", 0.65);
    expect(r.status).toBe("partial");
    expect(r.answers.support?.score).toBeNull();
    expect(r.composite?.value).toBeNull();
  });
  it("preserves cascade boundary semantics", async () => {
    for (const [probability, route] of [[0.19, "accept"], [0.2, "review"], [0.8, "escalate"]] as const) {
      const f = fake("yes", 0.9, probability);
      expect((await runWorkflow(parseWorkflow(chain), f.ask, "test", 0.65)).cascade?.route).toBe(route);
    }
  });
  it("accepts the existing CLI batch format in one call", async () => {
    const f = fake(), plan = parseWorkflow({ state: "source", questions: { logic: score, support: score }, composite: { logic: 0.4, support: 0.6 } });
    expect((await runWorkflow(plan, f.ask, "test", 0.65)).composite?.value).toBe(0.7);
    expect(f.calls).toHaveLength(1);
  });
  it("rejects cycles, unknown fields, invalid weights and unsupported conditions before inference", () => {
    for (const bad of [
      { ...chain, composite: { logic: 0.5, support: 0.6 } },
      { ...chain, stages: [chain.stages[1], chain.stages[0]] },
      { ...chain, questions: { q: gate } },
      { ...chain, composite: { risk: 1 } },
      { ...chain, cascade: { questions: ["risk"], accept_below: 0.8, escalate_at: 0.2 } },
      { state: "x", questions: JSON.parse('{"__proto__":{"type":"noul","instructions":"x"}}') },
    ]) expect(() => parseWorkflow(bad)).toThrow();
  });
  it("does not aggregate an incomplete malformed response", async () => {
    const f = fake(); let count = 0;
    const ask: AskJev = async (request) => ++count === 1 ? f.ask(request) : { model: "x", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } };
    const r = await runWorkflow(parseWorkflow(chain), ask, "test", 0.65);
    expect(r.status).toBe("fallback"); expect(r.composite?.value).toBeNull(); expect(r.cascade?.route).toBe("abstain");
  });
});

it("serves workflows directly and inline without forwarding internal fields", async () => {
  const f = fake(), up = fakeUpstream(), events = createEventLog();
  const app = createApp({ config: testConfig({ contextRouting: true }), askJev: f.ask, fetch: up.fetchImpl, events });
  const direct = await app.request("/master/decide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chain) });
  expect((await direct.json() as any).composite.value).toBe(0.7);
  expect(up.calls).toHaveLength(0);
  const inline = await app.request("/v1/responses", { method: "POST", body: JSON.stringify({ model: "test", input: "Compare", master_workflow: chain }) });
  await inline.text(); await settled();
  expect(up.calls[0]!.body).not.toHaveProperty("master_workflow");
  expect(up.calls[0]!.body.input).toContain('"value":0.7');
  const feed = events.since(0);
  expect(feed[0]!.context?.workflow?.composite?.value).toBe(0.7);
  expect(JSON.stringify(feed)).not.toContain('"evidence":"example"');
});
