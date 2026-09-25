import { PROVIDERS, resolveModel, resolveProvider, resolveUrl, type ProviderId } from "./jev.js";
export interface Config {
  /** Interface to listen on. Loopback by default: the gateway forwards credentials and must not be reachable from the LAN. */
  host: string;
  port: number;
  /** OpenAI-compatible API root, including the `/v1` suffix. */
  upstreamBaseUrl: string;
  /** Replaces the client's Authorization header upstream when set. */
  upstreamApiKey?: string;
  /** When set, clients must present this key to use the gateway. */
  routerApiKey?: string;
  /** Model used upstream once Jev has already picked the tool. */
  argsModel?: string;
  /** Who serves Jev: TypeSafe itself, or a gateway that resells it. */
  jevProvider: ProviderId;
  /** The key for that provider; the launchers ask for it when it is missing. */
  jevApiKey?: string;
  /** Endpoint the questions are posted to; the provider's own unless overridden (tests, proxies). */
  jevUrl: string;
  jevModel: string;
  jevTimeoutMs: number;
  /** Below this, Jev's tool decision is ignored and the LLM decides. */
  minConfidence: number;
  /** Confidence required per risk level; "low" is the floor (minConfidence). See docs.typesafe.ai/confidence. */
  riskThresholds: Record<Risk, number>;
  /** Transport retries for requests the API did not process (429/503/529, refused connection). */
  jevMaxRetries: number;
  jevRetryBaseMs: number;
  /** Per-argument certainty needed to answer without calling the LLM. */
  argMinCertainty: number;
  onNone: "force_none" | "passthrough";
  directCalls: boolean;
  /** False starts the gateway as a plain metering proxy; the dashboard can flip it at runtime. */
  routing: boolean;
  /** Evaluate supported textual contexts even without tools. */
  contextRouting: boolean;
  inspectInputs?: boolean;
  maxStateChars: number;
  maxMessageChars: number;
  /** Opt-in: dump every routed request (decoded body, redacted headers) into this directory. */
  debugDumpDir?: string;
  /** Who this router serves ("codex", "claude"); the dashboard labels its traffic with it. */
  client: string;
  /** JSON-lines file this process's stdout is appended to, if any: the dashboard's history. */
  logFile?: string;
}

type Env = Record<string, string | undefined>;

const str = (env: Env, key: string): string | undefined => {
  const value = env[key]?.trim();
  return value ? value : undefined;
};

const num = (env: Env, key: string, fallback: number): number => {
  const raw = str(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${key} must be a number, got "${raw}"`);
  return value;
};

const bool = (env: Env, key: string, fallback: boolean): boolean => {
  const raw = str(env, key)?.toLowerCase();
  if (raw === undefined) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
};

export type Risk = "low" | "medium" | "high";
export const RISKS: readonly Risk[] = ["low", "medium", "high"];

/** The threshold a request asked for through its risk level (default: the floor). */
export const thresholdFor = (config: Pick<Config, "riskThresholds">, risk: Risk | undefined) => config.riskThresholds[risk ?? "low"];

export function loadConfig(env: Env = process.env): Config {
  const jevProvider = resolveProvider(env);
  const onNone = str(env, "JEV_ON_NONE") ?? "force_none";
  if (onNone !== "force_none" && onNone !== "passthrough") {
    throw new Error(`JEV_ON_NONE must be "force_none" or "passthrough", got "${onNone}"`);
  }
  const config: Config = {
    host: str(env, "HOST") ?? "127.0.0.1",
    port: num(env, "PORT", 8787),
    upstreamBaseUrl: (str(env, "UPSTREAM_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
    upstreamApiKey: str(env, "UPSTREAM_API_KEY"),
    routerApiKey: str(env, "ROUTER_API_KEY"),
    argsModel: str(env, "ARGS_MODEL"),
    jevProvider,
    jevApiKey: str(env, PROVIDERS[jevProvider].keyEnv),
    jevUrl: resolveUrl(jevProvider, env),
    jevModel: resolveModel(jevProvider, str(env, "JEV_MODEL")),
    jevTimeoutMs: num(env, "JEV_TIMEOUT_MS", 8000),
    minConfidence: num(env, "JEV_MIN_CONFIDENCE", 0.65),
    riskThresholds: { low: 0, medium: 0, high: 0 },
    jevMaxRetries: num(env, "JEV_MAX_RETRIES", 2),
    jevRetryBaseMs: num(env, "JEV_RETRY_BASE_MS", 500),
    argMinCertainty: num(env, "JEV_ARG_MIN_CERTAINTY", 0.8),
    onNone,
    directCalls: bool(env, "JEV_DIRECT_CALLS", false),
    routing: bool(env, "JEV_ROUTING", true),
    inspectInputs: bool(env, "JEV_INSPECT_INPUTS", false),
    contextRouting: bool(env, "JEV_CONTEXT_ROUTING", true),
    maxStateChars: num(env, "JEV_MAX_STATE_CHARS", 60_000),
    maxMessageChars: num(env, "JEV_MAX_MESSAGE_CHARS", 4_000),
    debugDumpDir: str(env, "JEV_DEBUG_DUMP_DIR"),
    client: str(env, "JEV_CLIENT") ?? "standalone",
    logFile: str(env, "JEV_LOG_FILE"),
  };
  if (config.routerApiKey && !config.upstreamApiKey) {
    throw new Error("ROUTER_API_KEY requires UPSTREAM_API_KEY (the client key is not valid upstream)");
  }
  // Riskier actions demand more confidence; no level may fall below the floor or the level beneath it.
  const medium = Math.max(config.minConfidence, num(env, "JEV_MIN_CONFIDENCE_MEDIUM", 0.8));
  config.riskThresholds = { low: config.minConfidence, medium, high: Math.max(medium, num(env, "JEV_MIN_CONFIDENCE_HIGH", 0.9)) };
  if (!Number.isInteger(config.jevMaxRetries) || config.jevMaxRetries < 0 || config.jevMaxRetries > 5) throw new Error("JEV_MAX_RETRIES must be an integer in [0, 5]");
  if (config.jevRetryBaseMs <= 0 || config.jevRetryBaseMs > 5000) throw new Error("JEV_RETRY_BASE_MS must be in (0, 5000]");
  for (const value of [config.minConfidence, config.argMinCertainty, ...Object.values(config.riskThresholds)]) {
    if (value < 0 || value > 1) throw new Error("Confidence must be between 0 and 1");
  }
  if (config.jevTimeoutMs <= 0 || config.jevTimeoutMs > 15000) throw new Error("JEV_TIMEOUT_MS must be in (0, 15000]");
  if (config.maxStateChars < 1 || config.maxMessageChars < 1) throw new Error("Context limits must be positive");
  return config;
}
