import { timingSafeEqual } from "node:crypto";
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Adapter } from "./adapters/adapter.js";
import { chatAdapter } from "./adapters/chat.js";
import { geminiAdapter } from "./adapters/gemini.js";
import { messagesAdapter } from "./adapters/messages.js";
import { responsesAdapter } from "./adapters/responses.js";
import type { Config } from "./config.js";
import { dashboardRoutes, LOCAL_ORIGIN } from "./dashboard.js";
import { redactHeaders, summarizeResponse, type Dump } from "./debug.js";
import { decide, type AskJev, type Decision } from "./decide.js";
import { createEventLog, type EventLog } from "./events.js";
import { forward } from "./upstream.js";
import { readUsage } from "./usage.js";
import { assessContext, assessWorkflow, parseDecisionContext, contextNote, appendContextNote, type ContextReport } from "./context.js";

export interface Deps {
  config: Config;
  askJev: AskJev;
  /** Upstream transport; defaults to global fetch. */
  fetch?: typeof fetch;
  log?: (entry: Record<string, unknown>) => void;
  /** What the dashboard shows; defaults to an empty in-memory log. */
  events?: EventLog;
  /** Opt-in wire dumps (see debug.ts); off by default. */
  dump?: Dump;
}

type AnyRequest = { model?: string; stream?: boolean; tools?: unknown[]; master_context?: unknown; master_workflow?: unknown };

const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Largest provider request read into memory (Anthropic's own request limit is 32 MB). */
const MAX_ROUTED_BODY_BYTES = 32 * 1024 * 1024;
/** Largest /master/* request: decisions carry short texts, not conversations. */
const MAX_MASTER_BODY_BYTES = 65536;

const DECODERS: Record<string, (data: Uint8Array, options: { maxOutputLength: number }) => Buffer> = {
  zstd: zstdDecompressSync,
  gzip: gunzipSync,
  br: brotliDecompressSync,
  deflate: inflateSync,
};

/** Parse a JSON body, undoing request compression (Codex sends zstd). Undefined if unreadable. */
function parseBody<Req>(bytes: Uint8Array, encoding: string | undefined): Req | undefined {
  try {
    const decoder = encoding ? DECODERS[encoding.trim().toLowerCase()] : undefined;
    if (encoding && !decoder) return undefined;
    const parsed: unknown = JSON.parse(Buffer.from(decoder ? decoder(bytes, { maxOutputLength: MAX_ROUTED_BODY_BYTES }) : bytes).toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Req) : undefined;
  } catch {
    return undefined;
  }
}

function decisionHeaders(decision: Decision): Record<string, string> {
  const headers: Record<string, string> = { "x-jev-gateway-mode": decision.mode };
  // Header values must be Latin-1; an error message can be anything, and must not turn into a 500.
  if (decision.mode === "passthrough") headers["x-jev-gateway-reason"] = decision.reason.replace(/[^\x20-\x7e]/g, "?").slice(0, 120);
  if (decision.mode === "forced" || decision.mode === "direct" || decision.mode === "hint") {
    headers["x-jev-gateway-tool"] = decision.tool;
  }
  if (decision.jev) {
    headers["x-jev-gateway-confidence"] = decision.jev.confidence.toFixed(3);
    headers["x-jev-gateway-latency-ms"] = String(decision.jev.latencyMs);
  }
  return headers;
}

export function createApp({ config, askJev, fetch: fetchImpl = fetch, log: writeLog = () => {}, events = createEventLog(), dump }: Deps) {
  const app = new Hono();

  /** One routed request: a line in the log, and a row on the dashboard. */
  const log = (entry: Record<string, unknown>) => {
    writeLog(entry);
    events.record(entry);
  };

  /**
   * Log a forwarded request once its reply has ended, because that is when the provider says what
   * it cost. The reply is read from a clone in the background, so the client is never delayed.
   */
  const logWhenDone = (entry: Record<string, unknown>, response: Response, startedAt: number) => {
    const copy = response.clone();
    void readUsage(copy).then((usage) =>
      log({ ...entry, status: response.status, durationMs: Math.round(performance.now() - startedAt), ...(usage ? { usage } : {}) }),
    );
  };

  // Routing can be switched off at runtime to measure a baseline: same clients, same traffic,
  // same token accounting, but Jev is never asked and nothing is rewritten.
  let routing = config.routing;

  /**
   * Error bodies are the only documentation an undocumented backend offers, and a finished
   * stream's usage is the only way to see what a rewrite did to the prompt cache: keep both.
   * Reads a clone in the background, so the client's stream is never delayed.
   */
  const dumpResponse = (kind: string, response: Response, extra: Record<string, unknown> = {}) => {
    if (!dump) return;
    const failed = response.status >= 400;
    const copy = response.clone();
    void (async () => {
      let text = "";
      try {
        // Codex hangs up the moment it has `response.completed`, which aborts the upstream read
        // mid-stream: whatever arrived until then is the response.
        for await (const chunk of copy.body?.pipeThrough(new TextDecoderStream()) ?? []) text += chunk;
      } catch {}
      dump(failed ? kind : "response", {
        status: response.status,
        ...extra,
        ...(failed ? { body: text.slice(0, 20_000) } : summarizeResponse(text)),
      });
    })();
  };

  /**
   * The decision, plus how many tools the adapter found — they aren't always in `req.tools`.
   * Adapters read the request as the shape its API documents, and a body can be valid JSON without
   * being that shape (`"messages": [null]`). Whatever that makes them throw is not a reason to
   * fail the request: upstream gets to answer it, with its own error when it deserves one.
   */
  const decideFor = async <Req extends AnyRequest>(adapter: Adapter<Req>, req: Req): Promise<{ decision: Decision; tools?: number; context?: ContextReport }> => {
    let input: ReturnType<Adapter<Req>["toInput"]>;
    try {
      input = adapter.toInput(req, config.maxMessageChars);
    } catch {
      return { decision: { mode: "passthrough", reason: "unreadable_request" } };
    }
    if ("skip" in input) return { decision: { mode: "passthrough", reason: input.skip } };
    let context: ContextReport | undefined;
    // One deadline for classification, dependent assessment and tool routing together.
    const signal = AbortSignal.timeout(15_000);
    const requestAsk: AskJev = (request) => {
      signal.throwIfAborted();
      return askJev(request, signal);
    };
    if (config.contextRouting) {
      try {
        if (req.master_context !== undefined && req.master_workflow !== undefined) throw new Error("ambiguous_context");
        context = req.master_workflow !== undefined
          ? await assessWorkflow(req.master_workflow, config, requestAsk, signal)
          : await assessContext(input, parseDecisionContext(req.master_context), config, requestAsk);
      } catch {
        context = { status: "fallback", reason: "invalid_context", applied: false, calls: 0,
          inputTokens: 0, outputTokens: 0, latencyMs: 0, assessments: {}, questions: [] };
      }
    }
    try {
      return { decision: await decide(input, config, requestAsk), tools: input.tools.length, context };
    } catch (error) {
      return { decision: { mode: "passthrough", reason: `router_error: ${error instanceof Error ? error.message : String(error)}` }, tools: input.tools.length, context };
    }
  };

  const route = <Req extends AnyRequest>(adapter: Adapter<Req>) => async (c: Context) => {
    const startedAt = performance.now();
    const time = new Date().toISOString();
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    // Unreadable bodies are not ours to judge: upstream produces its own error for them.
    const req = parseBody<Req>(bytes, c.req.header("content-encoding"));
    dump?.("request", {
      method: c.req.method,
      path: c.req.path,
      headers: redactHeaders(c.req.raw.headers),
      body: req ?? `[unparseable, ${bytes.length} bytes]`,
    });

    let decision: Decision;
    let tools: number | undefined;
    let context: ContextReport | undefined;
    if (!req) decision = { mode: "passthrough", reason: "unparseable_body" };
    else if (c.req.header("x-jev-gateway") === "off") decision = { mode: "passthrough", reason: "disabled_by_header" };
    else if (!routing) decision = { mode: "passthrough", reason: "routing_disabled" };
    else ({ decision, tools, context } = await decideFor(adapter, req));

    const url = new URL(c.req.url);
    const fromUrl = adapter.fromUrl?.(url) ?? {};
    const entry = { event: "route", time, path: c.req.path, model: req?.model ?? fromUrl.model, tools: tools ?? req?.tools?.length ?? 0, context };
    // Building an answer or a rewrite is the gateway's own work. If it breaks, the original
    // request still goes upstream: the router must never be the reason a request fails.
    const giveUp = (error: unknown): Decision => ({
      mode: "passthrough",
      reason: `router_error: ${error instanceof Error ? error.message : String(error)}`,
      jev: decision.jev,
    });

    if (req && decision.mode === "direct") {
      try {
        const call = { tool: decision.tool, args: decision.args, inputTokens: decision.jev?.inputTokens ?? 0 };
        const headers = decisionHeaders(decision);
        const streamed = (fromUrl.stream ?? req.stream) ? adapter.directStream(req, call, url) : undefined;
        const json = streamed === undefined ? adapter.directJson(req, call) : undefined;
        log({ ...entry, ...decision });
        if (streamed === undefined) return c.json(json, 200, headers);
        if (typeof streamed !== "string") return c.body(streamed.body, 200, { ...headers, "content-type": streamed.contentType });
        return c.body(streamed, 200, { ...headers, "content-type": "text/event-stream", "cache-control": "no-cache" });
      } catch (error) {
        decision = giveUp(error);
      }
    }

    // Private harness extension must never reach a provider, even with routing disabled.
    let clean = req;
    const hasContext = !!req && (Object.hasOwn(req, "master_context") || Object.hasOwn(req, "master_workflow"));
    if (req && hasContext) {
      const { master_context: _, master_workflow: __, ...rest } = req;
      clean = rest as Req;
    }
    let rewritten: Req | undefined = hasContext ? clean : undefined;
    if (clean && decision.mode !== "passthrough") {
      try {
        rewritten = adapter.apply(clean, decision, config.argsModel);
      } catch (error) {
        decision = giveUp(error);
      }
    }
    const note = context && contextNote(context);
    if (clean && context && note) {
      const annotated = appendContextNote(rewritten ?? clean, note);
      if (annotated) {
        rewritten = annotated;
        context.applied = true;
      }
    }

    if (rewritten) {
      const body = JSON.stringify(rewritten);
      const response = await forward(c.req.raw, config, fetchImpl, { body, responseHeaders: decisionHeaders(decision) });
      const sent = { mode: decision.mode, model: rewritten.model, tool_choice: (rewritten as { tool_choice?: unknown }).tool_choice };
      dumpResponse("rejected", response, { sent });
      if (response.status !== 400 && response.status !== 422) {
        logWhenDone({ ...entry, ...decision }, response, startedAt);
        return response;
      }
      // The upstream refused the rewritten request (some backends only accept tool_choice
      // "auto"): the router must never be the reason a request fails, so replay the original.
      await response.body?.cancel();
      decision = { mode: "passthrough", reason: `upstream_rejected_${decision.mode}`, jev: decision.jev };
      if (context) { context.applied = false; context.reason = "upstream_rejected_rewrite"; }
    }

    const response = await forward(c.req.raw, config, fetchImpl, {
      body: hasContext ? JSON.stringify(clean) : bytes,
      responseHeaders: decisionHeaders(decision),
    });
    logWhenDone({ ...entry, ...decision }, response, startedAt);
    dumpResponse("upstream-error", response);
    return response;
  };

  /**
   * Any web page can send simple requests to loopback, and a DNS-rebinding page can do it under its
   * own host name. Without a key, only this machine's own host names are served; and no page from
   * another site may call the routes that spend the JEV or provider key. Requiring JSON on the
   * decision routes forces a CORS preflight, which the gateway never grants.
   */
  app.use("*", async (c, next) => {
    const forbidden = (message: string, status: 403 | 415 = 403) => c.json({ error: { message, type: status === 403 ? "forbidden" : "invalid_request_error" } }, status);
    const host = (c.req.header("host") ?? new URL(c.req.url).host).toLowerCase();
    if (!config.routerApiKey && !LOCAL_ORIGIN.test(`http://${host}`)) return forbidden("Host not allowed");
    if (!/^\/(master|router|v1|v1beta)\//.test(c.req.path)) return next();
    const origin = c.req.header("origin");
    if (origin !== undefined && !LOCAL_ORIGIN.test(origin)) return forbidden("Origin not allowed");
    const json = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json";
    if ((c.req.path.startsWith("/master/") || c.req.path === "/router/decide") && !json) return forbidden("Content-Type must be application/json", 415);
    return next();
  });

  const routedLimit = bodyLimit({ maxSize: MAX_ROUTED_BODY_BYTES,
    onError: (c) => c.json({ error: { message: "Request body too large", type: "invalid_request_error" } }, 413) });
  const masterLimit = bodyLimit({ maxSize: MAX_MASTER_BODY_BYTES,
    onError: (c) => c.json({ status: "fallback", reason: "request_too_large" }, 413) });

  // Answers before the key is checked, so that a launcher can find its gateway. A gateway that
  // has a key is one somebody else may reach: it says that it is up, and nothing about itself.
  app.get("/health", (c) =>
    c.json(config.routerApiKey ? { status: "ok" } : { status: "ok", pid: process.pid, upstream: config.upstreamBaseUrl, jev: config.jevProvider }),
  );

  app.use("*", async (c, next) => {
    if (!config.routerApiKey) return next();
    // A browser can't attach a header to a page it navigates to, so the dashboard — and only the
    // dashboard — may carry the key as `?key=`.
    const inQuery = c.req.path.startsWith("/dashboard") ? c.req.query("key") : undefined;
    const presented = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? inQuery ?? "";
    if (safeEqual(presented, config.routerApiKey)) return next();
    return c.json({ error: { message: "Invalid master-jev-hook API key", type: "invalid_api_key" } }, 401);
  });

  /**
   * Dry run: what would the router do with this body? Calls Jev, never upstream.
   * Accepts any routed wire format; `?format=chat|responses|messages` overrides the guess.
   */
  app.post("/router/decide", routedLimit, async (c) => {
    const req = parseBody<Record<string, unknown>>(new Uint8Array(await c.req.arrayBuffer()), undefined);
    if (!req) return c.json({ error: { message: "Body must be a JSON object", type: "invalid_request_error" } }, 400);
    const adapters = { chat: chatAdapter, responses: responsesAdapter, messages: messagesAdapter, gemini: geminiAdapter };
    // Chat Completions and Anthropic Messages both use `messages`; only Anthropic has a top-level
    // `system` or tools described by `input_schema`. Gemini uses `contents`.
    const tools = Array.isArray(req.tools) ? (req.tools as Record<string, unknown>[]) : [];
    const guess = "contents" in req
      ? "gemini"
      : !("messages" in req)
        ? "responses"
        : "system" in req || tools.some((tool) => tool && typeof tool === "object" && "input_schema" in tool)
          ? "messages"
          : "chat";
    const format = (c.req.query("format") ?? guess) as keyof typeof adapters;
    const adapter = (adapters[format] ?? adapters[guess]) as Adapter<AnyRequest>;
    const result = await decideFor(adapter, req);
    log({ event: "route", time: new Date().toISOString(), path: "/router/decide", model: req.model, tools: result.tools ?? 0, ...result.decision, context: result.context });
    const { inspection, ...context } = result.context ?? {};
    return c.json({ ...result.decision, ...(result.context ? { context } : {}) });
  });

  app.post("/master/context", masterLimit, async (c) => {
    if (!routing || c.req.header("x-jev-gateway") === "off") return c.json({ status: "skipped", reason: "routing_disabled" });
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    try {
      const body = parseBody<Record<string, unknown>>(bytes, undefined);
      if (!body || Object.keys(body).some((k) => !["objective", "context"].includes(k)) || typeof body.objective !== "string" || !body.objective.trim() || body.objective.length > 8000) throw new Error("invalid_objective");
      const supplied = parseDecisionContext(body.context);
      if (!supplied) throw new Error("missing_context");
      const signal = AbortSignal.timeout(15000);
      const context = await assessContext({ system: "", turns: [{ role: "user", text: body.objective }], tools: [], toolChoice: "auto" }, supplied, config,
        (request) => askJev(request, signal));
      log({ event: "route", time: new Date().toISOString(), path: "/master/context", tools: 0, mode: "passthrough", reason: "decision_only", context });
      const { inspection, ...response } = context;
      return c.json(response);
    } catch {
      return c.json({ status: "fallback", reason: "invalid_context" }, 400);
    }
  });

  // Explicit batches/chains from the harness, independent of any model-provider protocol.
  app.post("/master/decide", masterLimit, async (c) => {
    if (!routing || c.req.header("x-jev-gateway") === "off") return c.json({ status: "skipped", reason: "routing_disabled" });
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    try {
      const report = await assessWorkflow(parseBody(bytes, undefined), config, askJev);
      log({ event: "route", time: new Date().toISOString(), path: "/master/decide", tools: 0, mode: "passthrough", reason: "decision_only", context: report });
      return c.json(report.workflow!);
    } catch {
      return c.json({ status: "fallback", reason: "invalid_workflow" }, 400);
    }
  });

  app.route(
    "/dashboard",
    dashboardRoutes(config, events, { get: () => routing, set: (enabled) => void (routing = enabled) }),
  );

  app.post("/v1/chat/completions", routedLimit, route(chatAdapter));
  app.post("/v1/responses", routedLimit, route(responsesAdapter));
  app.post("/v1/messages", routedLimit, route(messagesAdapter));
  app.post("/v1beta/models/*", routedLimit, route(geminiAdapter));

  // Everything else (models, embeddings, …) is proxied untouched.
  app.all("/v1/*", async (c) => {
    const response = await forward(c.req.raw, config, fetchImpl);
    dump?.("other", { method: c.req.method, path: c.req.path, headers: redactHeaders(c.req.raw.headers), status: response.status });
    logWhenDone({ event: "route", time: new Date().toISOString(), path: c.req.path, tools: 0, mode: "passthrough", reason: "unrouted_endpoint" }, response, performance.now());
    return response;
  });
  app.all("/v1beta/*", async (c) => {
    const response = await forward(c.req.raw, config, fetchImpl);
    dump?.("other", { method: c.req.method, path: c.req.path, headers: redactHeaders(c.req.raw.headers), status: response.status });
    logWhenDone({ event: "route", time: new Date().toISOString(), path: c.req.path, tools: 0, mode: "passthrough", reason: "unrouted_endpoint" }, response, performance.now());
    return response;
  });

  return app;
}
