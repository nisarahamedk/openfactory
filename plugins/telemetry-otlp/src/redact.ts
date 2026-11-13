/**
 * Redaction before anything leaves the factory. Two layers:
 * 1. Only attributes the exporter builds itself are sent (no pass-through of event data).
 * 2. Every string that is sent goes through `redact`, which masks secret-shaped values.
 * Free text (ask, turn summaries) is off by default; titles are on.
 */
const PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI / Anthropic style keys
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // email addresses
];

export function redact(text: string, extra: readonly RegExp[] = []): string {
  let out = text;
  for (const p of [...PATTERNS, ...extra]) out = out.replace(p, "[REDACTED]");
  return out;
}
