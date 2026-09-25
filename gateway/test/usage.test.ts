import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { readUsage } from "../src/usage.js";
import { chat, fakeJev, settled, testConfig } from "./helpers.js";

const sse = (events: object[]) =>
  new Response(events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

describe("readUsage", () => {
  it("reads a Responses stream, reasoning and cache included", async () => {
    const usage = await readUsage(
      sse([
        { type: "response.output_text.delta", delta: 'a "usage" lookalike' },
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 13750,
              input_tokens_details: { cached_tokens: 9600 },
              output_tokens: 48,
              output_tokens_details: { reasoning_tokens: 32 },
            },
          },
        },
      ]),
    );
    expect(usage).toEqual({ input: 13750, cached: 9600, cacheWrite: 0, output: 48, reasoning: 32 });
  });

  it("recognises a stream that comes without a content-type, as the ChatGPT Codex backend sends it", async () => {
    const body = `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { usage: { attribution: { items: { a: { input_tokens: 1 } } }, input_tokens: 5713, input_tokens_details: { cached_tokens: 4152 }, output_tokens: 7 } },
    })}\n\n`;
    expect(await readUsage(new Response(body))).toMatchObject({ input: 5713, cached: 4152, output: 7 });
  });

  it("adds Anthropic's three input buckets into one total and takes the final output count", async () => {
    const usage = await readUsage(
      sse([
        {
          type: "message_start",
          message: { usage: { input_tokens: 12, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500, output_tokens: 1 } },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 210 } },
      ]),
    );
    expect(usage).toEqual({ input: 9512, cached: 9000, cacheWrite: 500, output: 210, reasoning: 0 });
  });

  it("reads plain JSON replies, and the Chat Completions vocabulary", async () => {
    const usage = await readUsage(
      Response.json({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 64 },
          completion_tokens_details: { reasoning_tokens: 8 },
        },
      }),
    );
    expect(usage).toEqual({ input: 100, cached: 64, cacheWrite: 0, output: 20, reasoning: 8 });
  });

  it("reports nothing rather than zeros when the reply never said", async () => {
    expect(await readUsage(new Response("<html>bad gateway</html>", { status: 502 }))).toBeUndefined();
  });
});

describe("baseline mode", () => {
  const upstream = (async () =>
    Response.json({ usage: { prompt_tokens: 100, completion_tokens: 20 } })) as unknown as typeof fetch;
  const post = (app: ReturnType<typeof createApp>) =>
    app.request("/v1/chat/completions", { method: "POST", body: JSON.stringify(chat("kitchen lights on")) });
  const feed = async (app: ReturnType<typeof createApp>) => {
    await settled();
    return (await (await app.request("/dashboard/events")).json()) as { router: { routing: boolean }; events: any[] };
  };

  it("meters traffic without ever asking Jev when routing starts off", async () => {
    const jev = fakeJev({});
    const app = createApp({ config: testConfig({ routing: false }), askJev: jev.askJev, fetch: upstream });
    const res = await post(app);

    expect(jev.requests).toHaveLength(0);
    expect(res.headers.get("x-jev-gateway-reason")).toBe("routing_disabled");
    const { router, events } = await feed(app);
    expect(router.routing).toBe(false);
    expect(events[0]).toMatchObject({ mode: "passthrough", reason: "routing_disabled", usage: { input: 100, output: 20 } });
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("can be switched at runtime, by this machine's pages only", async () => {
    const jev = fakeJev({ tool: { choice: "get_weather" }, needs_tool: { noul: 0.9 } });
    const app = createApp({ config: testConfig({ directCalls: false }), askJev: jev.askJev, fetch: upstream });
    const flip = (enabled: string, origin?: string) =>
      app.request(`/dashboard/routing?enabled=${enabled}`, { method: "POST", headers: origin ? { origin } : {} });

    expect((await flip("false", "https://evil.example")).status).toBe(403);
    expect((await flip("maybe")).status).toBe(400);
    expect(await (await flip("false", "http://localhost:8789")).json()).toEqual({ routing: false });
    await post(app);
    expect(jev.requests).toHaveLength(0);

    await flip("true");
    await post(app);
    expect(jev.requests).toHaveLength(1);
    expect((await feed(app)).events.map((event) => event.mode)).toEqual(["passthrough", "forced"]);
  });
});
