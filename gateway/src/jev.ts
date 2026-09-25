import type { Questions, SystemOneRequest, SystemOneResult } from "@typesafe-ai/sdk";
import type { Config } from "./config.js";
import type { AskJev } from "./decide.js";
import providers from "./providers.json" with { type: "json" };

/**
 * Where Jev can be reached. TypeSafe's own API, and two gateways that resell it: all three take
 * the same request body and return the same answers, so one transport serves them. The table is
 * JSON because the launchers' setup wizard (plain .mjs, no build step) reads the same file.
 */
export type ProviderId = keyof typeof providers;
export const PROVIDERS = providers;
export const isProvider = (value: string): value is ProviderId => Object.hasOwn(providers, value);

type Env = Record<string, string | undefined>;
const present = (env: Env, name: string) => Boolean(env[name]?.trim());

/** An explicit JEV_PROVIDER wins; otherwise whichever key is there, TypeSafe's own first. */
export function resolveProvider(env: Env): ProviderId {
  const chosen = env.JEV_PROVIDER?.trim().toLowerCase();
  if (chosen) {
    if (!isProvider(chosen)) throw new Error(`JEV_PROVIDER must be one of ${Object.keys(providers).join(", ")}, got "${chosen}"`);
    return chosen;
  }
  return (Object.keys(providers) as ProviderId[]).find((id) => present(env, providers[id].keyEnv)) ?? "typesafe";
}

/**
 * Model ids live in different namespaces: TypeSafe's have no slash (`jev-latest`), the gateways'
 * do (`typesafe/jev-1.13`). A JEV_MODEL written for one provider is ignored under another, so
 * switching provider never sends an id the new one cannot know.
 */
export function resolveModel(provider: ProviderId, requested: string | undefined): string {
  const fits = requested && requested.includes("/") === (provider !== "typesafe");
  return fits ? requested : providers[provider].model;
}

/**
 * JEV_URL replaces the endpoint outright. TYPESAFE_BASE_URL is the variable TypeSafe's own SDK
 * reads, kept so a local stand-in for Jev (scripts/mock-jev.mjs) plugs in the way it always did.
 */
export function resolveUrl(provider: ProviderId, env: Env): string {
  const explicit = env.JEV_URL?.trim();
  if (explicit) return explicit;
  const base = provider === "typesafe" ? env.TYPESAFE_BASE_URL?.trim() : undefined;
  return base ? `${base.replace(/\/+$/, "")}/v1/systemone` : providers[provider].url;
}


/** Some gateways return choice answers without a confidence; the winning probability stands in. */
function normalize(result: SystemOneResult<Questions>): SystemOneResult<Questions> {
  const answers: Record<string, unknown> = {};
  for (const [name, answer] of Object.entries(result.answers ?? {})) {
    const probability = answer?.type === "choice" ? answer.probabilities?.[answer.choice] : undefined;
    answers[name] =
      answer?.type === "choice" && typeof answer.confidence !== "number" && typeof probability === "number"
        ? { ...answer, confidence: probability }
        : answer;
  }
  return { model: result.model, answers, usage: { input_tokens: result.usage?.input_tokens ?? 0, output_tokens: result.usage?.output_tokens ?? 0 } } as SystemOneResult<Questions>;
}

/** The one call the gateway makes to Jev, for whichever provider is configured. */
/** Statuses meaning the API did not process the request (rate limit, overload): safe to resend. */
const UNPROCESSED = new Set([429, 503, 529]);
/** Waits longer than this are not worth it inside a decision's deadline. */
const MAX_RETRY_WAIT_MS = 5000;

/** The server's own hint, in ms: `retry-after-ms`, or `retry-after` as seconds or an HTTP date. */
function retryAfter(headers: Headers): number | undefined {
  const ms = Number(headers.get("retry-after-ms"));
  if (headers.has("retry-after-ms") && Number.isFinite(ms) && ms >= 0) return ms;
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** A refused or unresolvable connection never reached the API, so it cannot have been billed. */
const neverReached = (error: unknown) =>
  ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(String((error as { cause?: { code?: unknown } })?.cause?.code));

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal?.throwIfAborted();
  const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(signal!.reason); };
  signal?.addEventListener("abort", stop, { once: true });
});

export function createAskJev(config: Pick<Config, "jevProvider" | "jevApiKey" | "jevUrl" | "jevTimeoutMs"> & Partial<Pick<Config, "jevMaxRetries" | "jevRetryBaseMs">>, fetchImpl: typeof fetch = fetch): AskJev {
  const provider = providers[config.jevProvider];
  if (!config.jevApiKey) {
    throw new Error(`No API key for Jev: set ${provider.keyEnv} (${provider.label}), or run master-jev-codex --setup.`);
  }
  const once = async (request: SystemOneRequest<Questions>, signal?: AbortSignal) => {
    const response = await fetchImpl(config.jevUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.jevApiKey}`,
        "content-type": "application/json",
        // OpenRouter attributes traffic by these; the others ignore them.
        "http-referer": "https://github.com/sophia-phillipa/master-jev-hook",
        "x-title": "master-jev-hook",
      },
      body: JSON.stringify(request),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(config.jevTimeoutMs)]) : AbortSignal.timeout(config.jevTimeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error(`JEV HTTP ${response.status}`), { status: response.status, retryAfterMs: retryAfter(response.headers) });
    }
    const result = normalize((await response.json()) as SystemOneResult<Questions>);
    if (Object.keys(result.answers).sort().join() !== Object.keys(request.questions).sort().join()) throw new Error("invalid_jev_answers");
    const unit = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
    for (const [id, q] of Object.entries(request.questions)) {
      const a = result.answers[id];
      if (!a || a.type !== q.type) throw new Error("invalid_jev_answer_type");
      if (a.type === "choice" && q.type === "choice" && (!unit(a.confidence) || !Object.hasOwn(q.criteria, a.choice) || !a.probabilities || Object.entries(a.probabilities).some(([k, v]) => !Object.hasOwn(q.criteria, k) || !unit(v)))) throw new Error("invalid_jev_choice");
      if (a.type === "score" && q.type === "score" && (!unit(a.confidence) || !Array.isArray(q.criteria) || typeof a.score !== "number" || !Number.isFinite(a.score) || a.score < 0 || a.score > q.criteria.length - 1)) throw new Error("invalid_jev_score");
      if (a.type === "noul" && !unit(a.noul)) throw new Error("invalid_jev_probability");
    }
    return result;
  };
  // Transport retries only for requests the API did not process (docs.typesafe.ai/api: back off on
  // 429/529). Timeouts, 5xx and invalid answers are never resent: they may already have been billed,
  // and a decision's answer is never re-asked. Waits honor retry-after and the caller's deadline.
  const retries = config.jevMaxRetries ?? 2;
  const base = config.jevRetryBaseMs ?? 500;
  return async (request, signal) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(request, signal);
      } catch (error) {
        const status = (error as { status?: number }).status;
        const retryable = status !== undefined ? UNPROCESSED.has(status) : neverReached(error);
        if (!retryable || attempt >= retries || signal?.aborted) throw error;
        const backoff = Math.min(base * 2 ** attempt, MAX_RETRY_WAIT_MS) * (1 + Math.random() * 0.25);
        const wait = (error as { retryAfterMs?: number }).retryAfterMs ?? backoff;
        if (wait > MAX_RETRY_WAIT_MS) throw error;
        await sleep(wait, signal);
      }
    }
  };
}
