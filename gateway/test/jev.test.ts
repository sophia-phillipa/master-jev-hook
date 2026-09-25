import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createAskJev, resolveModel, resolveProvider } from "../src/jev.js";

const request = { model: "m", state: "s", questions: { tool: { type: "choice" as const, instructions: "?", criteria: { a: null, b: null } } } };

function capture(reply: () => Response) {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return reply();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("choosing a provider", () => {
  it("follows whichever key is present, TypeSafe's own first, unless JEV_PROVIDER says otherwise", () => {
    expect(resolveProvider({})).toBe("typesafe");
    expect(resolveProvider({ OPENROUTER_API_KEY: "k" })).toBe("openrouter");
    expect(resolveProvider({ AI_GATEWAY_API_KEY: "k" })).toBe("vercel");
    expect(resolveProvider({ TYPESAFE_API_KEY: "k", OPENROUTER_API_KEY: "k" })).toBe("typesafe");
    expect(resolveProvider({ TYPESAFE_API_KEY: "k", OPENROUTER_API_KEY: "k", JEV_PROVIDER: "OpenRouter" })).toBe("openrouter");
    expect(() => resolveProvider({ JEV_PROVIDER: "acme" })).toThrow(/JEV_PROVIDER/);
  });

  it("never sends one provider's model id to another", () => {
    expect(resolveModel("typesafe", undefined)).toBe("jev-latest");
    expect(resolveModel("typesafe", "jev-1.13.0")).toBe("jev-1.13.0");
    expect(resolveModel("openrouter", "jev-latest")).toBe("typesafe/jev-1.13");
    expect(resolveModel("openrouter", "typesafe/jev-1.13-20260917")).toBe("typesafe/jev-1.13-20260917");
    expect(resolveModel("typesafe", "typesafe-ai/jev")).toBe("jev-latest");
  });

  it("reads the matching key, endpoint and model into the config", () => {
    const config = loadConfig({ AI_GATEWAY_API_KEY: "vck", JEV_MODEL: "jev-latest" });
    expect(config).toMatchObject({ jevProvider: "vercel", jevApiKey: "vck", jevModel: "typesafe-ai/jev", jevUrl: "https://ai-gateway.vercel.sh/typesafe/v1/systemone" });
    expect(loadConfig({ OPENROUTER_API_KEY: "ork" }).jevUrl).toBe("https://openrouter.ai/api/alpha/decisions");
    // The variable TypeSafe's SDK reads still points a local stand-in at the gateway.
    expect(loadConfig({ TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: "http://127.0.0.1:8799/" }).jevUrl).toBe("http://127.0.0.1:8799/v1/systemone");
  });
});

describe("asking Jev", () => {
  const answer = { model: "m", answers: { tool: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } } }, usage: { input_tokens: 10, output_tokens: 0 } };

  it("posts the same body to whichever provider, with its key as a bearer token", async () => {
    for (const env of [{ TYPESAFE_API_KEY: "k1" }, { OPENROUTER_API_KEY: "k2" }, { AI_GATEWAY_API_KEY: "k3" }]) {
      const config = loadConfig(env);
      const { calls, fetchImpl } = capture(() => Response.json(answer));
      const result = await createAskJev(config, fetchImpl)(request);
      expect(calls[0]!.url).toBe(config.jevUrl);
      expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${Object.values(env)[0]}`);
      expect(calls[0]!.body).toEqual(request);
      expect(result.answers.tool).toMatchObject({ choice: "a", confidence: 0.9 });
    }
  });

  it("stands the winning probability in for a missing confidence, and a missing usage for zero", async () => {
    const bare = { answers: { tool: { type: "choice", choice: "a", probabilities: { a: 0.8, b: 0.2 } } } };
    const { fetchImpl } = capture(() => Response.json(bare));
    const result = await createAskJev(loadConfig({ AI_GATEWAY_API_KEY: "k" }), fetchImpl)(request);
    expect(result.answers.tool).toMatchObject({ confidence: 0.8 });
    expect(result.usage.input_tokens).toBe(0);
  });

  const fast = { TYPESAFE_API_KEY: "k", JEV_RETRY_BASE_MS: "1" };
  const answer429 = (headers: Record<string, string> = {}) => new Response("secret-key-in-error", { status: 429, headers });

  it("retries requests the API did not process (429, 503, 529), then gives up without exposing bodies", async () => {
    for (const status of [429, 503, 529]) {
      const failed = capture(() => new Response("secret-key-in-error", { status }));
      const error = await createAskJev(loadConfig(fast), failed.fetchImpl)(request).catch((e) => e);
      expect(String(error.message)).toBe(`JEV HTTP ${status}`);
      expect(failed.calls).toHaveLength(3);
    }
  });

  it("succeeds on a retry after a rate limit", async () => {
    let n = 0;
    const f = capture(() => (n++ === 0 ? answer429({ "retry-after-ms": "5" }) : Response.json(answer)));
    const result = await createAskJev(loadConfig(fast), f.fetchImpl)(request);
    expect(result.answers.tool).toMatchObject({ choice: "a" });
    expect(f.calls).toHaveLength(2);
  });

  it("does not wait for a retry-after longer than the retry budget", async () => {
    const f = capture(() => answer429({ "retry-after": "30" }));
    const started = performance.now();
    await expect(createAskJev(loadConfig(fast), f.fetchImpl)(request)).rejects.toThrow("JEV HTTP 429");
    expect(f.calls).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("never retries errors that may have been processed or billed (401, 500, timeouts), nor when disabled", async () => {
    for (const status of [401, 500]) {
      const failed = capture(() => new Response("x", { status }));
      await expect(createAskJev(loadConfig(fast), failed.fetchImpl)(request)).rejects.toThrow(`JEV HTTP ${status}`);
      expect(failed.calls).toHaveLength(1);
    }
    let calls = 0;
    const timeout = (async () => { calls++; throw new DOMException("timed out", "TimeoutError"); }) as unknown as typeof fetch;
    await expect(createAskJev(loadConfig(fast), timeout)(request)).rejects.toThrow();
    expect(calls).toBe(1);
    const off = capture(() => answer429());
    await expect(createAskJev(loadConfig({ ...fast, JEV_MAX_RETRIES: "0" }), off.fetchImpl)(request)).rejects.toThrow("JEV HTTP 429");
    expect(off.calls).toHaveLength(1);
  });

  it("retries a refused connection, which never reached the API", async () => {
    let calls = 0;
    const refused = (async () => {
      if (calls++ === 0) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      return Response.json(answer);
    }) as unknown as typeof fetch;
    await expect(createAskJev(loadConfig(fast), refused)(request)).resolves.toBeDefined();
    expect(calls).toBe(2);
  });

  it("stops retrying when the caller's deadline aborts", async () => {
    const controller = new AbortController();
    const f = capture(() => { controller.abort(); return answer429(); });
    await expect(createAskJev(loadConfig(fast), f.fetchImpl)(request, controller.signal)).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  });

  it("rejects unknown IDs and invalid probabilities before tool routing", async () => {
    for (const a of [
      { ...answer, answers: { tool: { ...answer.answers.tool, confidence: 2 } } },
      { ...answer, answers: { tool: { ...answer.answers.tool, choice: "unknown" } } },
      { ...answer, answers: {} },
    ]) {
      const f = capture(() => Response.json(a));
      await expect(createAskJev(loadConfig({ TYPESAFE_API_KEY: "k" }), f.fetchImpl)(request)).rejects.toThrow(/invalid_jev/);
    }
  });

  it("propagates the whole-request abort signal to transport", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const f = (async (_: unknown, init: RequestInit) => {
      received = init.signal as AbortSignal;
      controller.abort();
      received.throwIfAborted();
    }) as unknown as typeof fetch;
    await expect(createAskJev(loadConfig({ TYPESAFE_API_KEY: "k" }), f)(request, controller.signal)).rejects.toThrow();
    expect(received?.aborted).toBe(true);
  });

  it("says which variable to set when there is no key", () => {
    expect(() => createAskJev(loadConfig({ JEV_PROVIDER: "openrouter" }))).toThrow(/OPENROUTER_API_KEY/);
  });
});

 it("never borrows another option's probability for the selected choice", async () => {
    const config = loadConfig({ TYPESAFE_API_KEY: "fixture" });
    const f = capture(() => Response.json({ answers: { tool: { type: "choice", choice: "a", probabilities: { a: 0.1, b: 0.9 } } } }));
    expect((await createAskJev(config, f.fetchImpl)(request)).answers.tool).toMatchObject({ confidence: 0.1 });
    for (const probabilities of [{ b: 0.9 }, {}]) {
      const missing = capture(() => Response.json({ answers: { tool: { type: "choice", choice: "a", probabilities } } }));
      await expect(createAskJev(config, missing.fetchImpl)(request)).rejects.toThrow(/invalid_jev/);
    }
  });
  it("rejects inherited provider names", () => {
    expect(() => resolveProvider({ JEV_PROVIDER: "constructor" })).toThrow(/JEV_PROVIDER/);
  });
