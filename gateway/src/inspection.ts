/** Private diagnostic copies only; never capture transport headers. */
export interface Inspection { received: unknown; requests: unknown[] }
export function inspect(value: unknown, secrets: (string | undefined)[] = []): unknown {
  return JSON.parse(JSON.stringify(value, (key, v) => {
    if (/^(authorization|cookie|password|secret|token|api[_-]?key|access[_-]?token)$/i.test(key)) return "[REDACTED]";
    if (typeof v !== "string") return v;
    for (const secret of secrets) if (secret) v = v.split(secret).join("[REDACTED]");
    return v.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]").replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]");
  }));
}
