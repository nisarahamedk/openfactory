/**
 * What kind of failure stopped a phase, so the job can react the right way:
 *
 *   passing  a blip (network, 429, 5xx, overloaded model). Retried by itself with backoff.
 *   setup    the factory is set up wrong (a model the key may not use, a token without access).
 *            Retrying won't help; a person fixes the setup, then presses Retry.
 *   agent    the agent ran but didn't produce something reviewable. A person reads it and decides.
 *   unknown  anything else. Treated like setup: stop, and say what happened.
 */
export type ErrorKind = "passing" | "setup" | "agent" | "unknown";

/** Thrown when a start-up check (model access, code-host access) fails before any work starts. */
export class SetupError extends Error {
  constructor(message: string, readonly fix: string) {
    super(message);
    this.name = "SetupError";
  }
}

/** Thrown when the agent ended its turns without a reviewable result. */
export class AgentGaveUp extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentGaveUp";
  }
}

const PASSING = [
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bETIMEDOUT\b/,
  /\bEAI_AGAIN\b/,
  /\bEPIPE\b/,
  /socket hang up/i,
  /fetch failed/i,
  /network error/i,
  /\boverloaded\b/i,
  /rate.?limit/i,
  /too many requests/i,
  /\(status (429|500|502|503|504|529)\)/,
  /→ (429|500|502|503|504):/,
  /\b(429|502|503|504|529)\b.*(error|status|too many|unavailable|gateway)/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /temporarily unavailable/i,
];

const SETUP: Array<{ re: RegExp; fix: string }> = [
  {
    re: /selected model .*(may not exist|not have access)|model .* (not found|does not exist|not allowed)|key not allowed to access model|invalid model/i,
    fix: "The model this task was routed to isn't available to the factory's gateway key. Add it to the key's models (or change the routing), then retry.",
  },
  { re: /→ 404:/, fix: "The code host says this doesn't exist or the token can't see it. Check the repo name and the token's access, then retry." },
  { re: /\(status 401\)|→ 401:|\b401\b.*unauthori[sz]ed|bad credentials|invalid api key|authentication/i, fix: "A credential was refused. Check the code-host token and the model gateway key, then retry." },
  { re: /\(status 403\)|→ 403:|\bforbidden\b|resource not accessible|permission denied/i, fix: "The factory's token isn't allowed to do this. Check its permissions for this repo, then retry." },
  { re: /budget.*exceeded|exceeded.*budget|max_budget/i, fix: "The model budget ran out. Raise the task or gateway budget, then retry." },
];

/** Sort a thrown value into a kind, with a plain-language fix where we know one. */
export function classifyError(e: unknown, message: string): { kind: ErrorKind; fix: string | null } {
  if (e instanceof SetupError) return { kind: "setup", fix: e.fix };
  if (e instanceof AgentGaveUp) return { kind: "agent", fix: "Read the agent's last turn, then comment with what to change, or press Retry to let it try again." };
  if (/rate.?limit|too many requests|overloaded/i.test(message)) return { kind: "passing", fix: null }; // GitHub rate limits come as 403
  for (const s of SETUP) if (s.re.test(message)) return { kind: "setup", fix: s.fix };
  if (PASSING.some((re) => re.test(message))) return { kind: "passing", fix: null };
  return { kind: "unknown", fix: null };
}

/** Delays before each automatic retry of a passing failure. Three tries over about 2.5 minutes. */
export const DEFAULT_RETRY_DELAYS_MS = [5_000, 30_000, 120_000];

/** Wait, but wake early (and throw) when the job is aborted. */
export function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
