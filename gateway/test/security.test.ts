import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { fakeJev, fakeUpstream, testConfig } from "./helpers.js";

const json = { "content-type": "application/json" };
const verify = JSON.stringify({ state: "x", questions: { q: { type: "noul", instructions: "yes?" } } });

describe("browser and DNS-rebinding protection", () => {
  const setup = (overrides = {}) => {
    const jev = fakeJev({ q: { noul: 0.9 } });
    const upstream = fakeUpstream();
    const app = createApp({ config: testConfig(overrides), askJev: jev.askJev, fetch: upstream.fetchImpl });
    return { app, jev, upstream };
  };

  it("refuses a cross-site simple POST without spending the JEV key", async () => {
    const { app, jev } = setup();
    const res = await app.request("http://127.0.0.1:8795/master/decide", {
      method: "POST", headers: { origin: "https://evil.example", "content-type": "text/plain" }, body: verify });
    expect(res.status).toBe(403);
    expect(jev.requests).toHaveLength(0);
  });

  it("requires application/json on the decision routes, even without an Origin", async () => {
    const { app, jev } = setup();
    for (const path of ["/master/decide", "/master/context", "/router/decide"]) {
      const res = await app.request(path, { method: "POST", headers: { "content-type": "text/plain" }, body: verify });
      expect(res.status, path).toBe(415);
    }
    expect(jev.requests).toHaveLength(0);
    const ok = await app.request("/master/decide", { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: verify });
    expect(ok.status).toBe(200);
  });

  it("refuses foreign Origins on provider routes but lets local pages and non-browser clients through", async () => {
    const { app, upstream } = setup();
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const foreign = await app.request("/v1/chat/completions", { method: "POST", headers: { ...json, origin: "https://evil.example" }, body });
    expect(foreign.status).toBe(403);
    const nullOrigin = await app.request("/v1/models", { headers: { origin: "null" } });
    expect(nullOrigin.status).toBe(403);
    expect(upstream.calls).toHaveLength(0);
    const local = await app.request("/v1/chat/completions", { method: "POST", headers: { ...json, origin: "http://localhost:3000" }, body });
    expect(local.status).toBe(200);
    const cli = await app.request("/v1/chat/completions", { method: "POST", headers: { ...json, host: "127.0.0.1:8795" }, body });
    expect(cli.status).toBe(200);
  });

  it("refuses a foreign Host header without a key (DNS rebinding) and accepts loopback names", async () => {
    const { app } = setup();
    const rebound = await app.request("http://attacker.example:8795/dashboard/events", { headers: { host: "attacker.example:8795" } });
    expect(rebound.status).toBe(403);
    expect((await app.request("http://attacker.example:8795/health", { headers: { host: "attacker.example:8795" } })).status).toBe(403);
    for (const host of ["127.0.0.1:8795", "localhost:8796", "[::1]:8795", "localhost"]) {
      expect((await app.request("/dashboard/events", { headers: { host } })).status, host).toBe(200);
    }
  });

  it("serves any Host when a key is required", async () => {
    const { app } = setup({ routerApiKey: "secret", upstreamApiKey: "up" });
    const res = await app.request("http://gateway.lan:8795/dashboard/events", { headers: { host: "gateway.lan:8795", authorization: "Bearer secret" } });
    expect(res.status).toBe(200);
  });
});

describe("request size limits", () => {
  it("rejects oversized routed and decision bodies from content-length, before reading them", async () => {
    const app = createApp({ config: testConfig({ contextRouting: true }), askJev: fakeJev({}).askJev, fetch: fakeUpstream().fetchImpl });
    const big = await app.request("/master/decide", { method: "POST", headers: { ...json, "content-length": String(70_000) }, body: "x".repeat(70_000) });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ status: "fallback", reason: "request_too_large" });
    // Without content-length the body is measured while read (the bodyLimit middleware, no second check).
    const streamed = await app.request("/master/context", { method: "POST", headers: json, body: "x".repeat(70_000) });
    expect(streamed.status).toBe(413);
    expect(await streamed.json()).toEqual({ status: "fallback", reason: "request_too_large" });
    const huge = await app.request("/router/decide", { method: "POST", headers: { ...json, "content-length": String(33 * 1024 * 1024) }, body: "{}" });
    expect(huge.status).toBe(413);
    const routed = await app.request("/v1/chat/completions", { method: "POST", headers: { ...json, "content-length": String(33 * 1024 * 1024) }, body: "{}" });
    expect(routed.status).toBe(413);
  });

  it("passes a compression bomb through instead of inflating it", async () => {
    const forwarded: number[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      forwarded.push((init?.body as Uint8Array).length);
      return Response.json({ ok: true });
    }) as typeof fetch;
    const app = createApp({ config: testConfig(), askJev: fakeJev({}).askJev, fetch: fetchImpl });
    const bomb = gzipSync(Buffer.alloc(40 * 1024 * 1024, 0x20));
    const res = await app.request("/v1/chat/completions", { method: "POST", headers: { ...json, "content-encoding": "gzip" }, body: bomb });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-jev-gateway-reason")).toBe("unparseable_body");
    expect(forwarded).toEqual([bomb.length]);
  });
});

describe("decision headers", () => {
  it("keeps a non-Latin-1 router error as a pass-through, not a 500", async () => {
    const upstream = fakeUpstream();
    const askJev = async () => { throw new Error("“quoted” — done ✓"); };
    const app = createApp({ config: testConfig(), askJev, fetch: upstream.fetchImpl });
    const body = { model: "m", messages: [{ role: "user", content: "weather in Paris?" }],
      tools: [{ type: "function", function: { name: "get_weather", description: "d", parameters: { type: "object", properties: {} } } }] };
    const res = await app.request("/v1/chat/completions", { method: "POST", headers: json, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-jev-gateway-mode")).toBe("passthrough");
    expect(res.headers.get("x-jev-gateway-reason")).toMatch(/^[a-z_]+: \?quoted\? \? done \?$/);
    expect(upstream.calls).toHaveLength(1);
  });
});

describe("configuration", () => {
  it("defaults to port 8795", () => {
    expect(loadConfig({}).port).toBe(8795);
  });

  it("refuses a non-loopback HOST without ROUTER_API_KEY", () => {
    expect(() => loadConfig({ HOST: "0.0.0.0" })).toThrow(/ROUTER_API_KEY/);
    expect(() => loadConfig({ HOST: "192.168.1.5" })).toThrow(/loopback/);
    // Other 127.x addresses would fail the local Host check (LOCAL_ORIGIN) on every request.
    expect(() => loadConfig({ HOST: "127.0.0.2" })).toThrow(/loopback/);
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) expect(loadConfig({ HOST: host }).host).toBe(host);
    expect(loadConfig({ HOST: "0.0.0.0", ROUTER_API_KEY: "k", UPSTREAM_API_KEY: "u" }).host).toBe("0.0.0.0");
  });
});
