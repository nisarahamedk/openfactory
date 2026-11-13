/**
 * OpenWorld check: run a PR head forward N simulated days in a world and report its invariants.
 *
 * The factory doesn't run worlds itself. It calls an OpenWorld runner over a small HTTP protocol, so
 * the runner can live wherever worlds run (a gVisor host, a k8s node pool) and any runner that speaks
 * the protocol plugs in:
 *
 *   POST {url}/v1/runs        { repo: "owner/name", sha, world, simDays }      → 202 { id }
 *   GET  {url}/v1/runs/{id}   → { id, status: queued|running|passed|failed|error, startedAt?, finishedAt?,
 *                                 invariants: [{ name, ok, detail }], metrics: [{ name, value, unit }],
 *                                 reportUrl?, error? }
 *
 * factory.yaml:
 *   world: { provider: openworld, name: payments-30d, simDays: 30, options: { url: https://openworld.internal } }
 * The bearer token comes from OPENWORLD_TOKEN (optional).
 */
import { defineProvider, type WorldCheck, type WorldCheckResult } from "@openfactory/contracts";
import { z } from "zod";

const Started = z.object({ id: z.string() });
const Run = z.object({
  id: z.string(),
  status: z.enum(["queued", "running", "passed", "failed", "error"]),
  startedAt: z.string().nullish(),
  finishedAt: z.string().nullish(),
  invariants: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string().default("") })).default([]),
  metrics: z.array(z.object({ name: z.string(), value: z.number(), unit: z.string().default("") })).default([]),
  reportUrl: z.string().nullish(),
  error: z.string().nullish(),
});

export type OpenWorldOptions = {
  url: string;
  token?: string | null;
  /** How often to ask whether the run finished. */
  pollMs?: number;
  /** Give up (status error) after this long; 30 simulated days usually take minutes. */
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });

export class OpenWorldCheck implements WorldCheck {
  readonly name = "openworld";
  constructor(private readonly o: OpenWorldOptions) {}

  async run(input: Parameters<WorldCheck["run"]>[0], signal?: AbortSignal): Promise<WorldCheckResult> {
    const now = this.o.now ?? (() => new Date().toISOString());
    const startedAt = now();
    const base = { world: input.world, headSha: input.headSha, simDays: input.simDays, startedAt };
    const fail = (detail: string): WorldCheckResult => ({ ...base, status: "error", finishedAt: now(), invariants: [{ name: "runner", ok: false, detail }], metrics: [], reportUrl: null });
    let id: string;
    try {
      const started = Started.parse(await this.call("POST", "/v1/runs", { repo: `${input.repo.owner}/${input.repo.name}`, sha: input.headSha, world: input.world, simDays: input.simDays }, signal));
      id = started.id;
    } catch (e) {
      return fail(`couldn't start the run: ${e instanceof Error ? e.message : String(e)}`);
    }
    const deadline = Date.now() + (this.o.timeoutMs ?? 30 * 60_000);
    const sleep = this.o.sleep ?? defaultSleep;
    for (;;) {
      let run: z.infer<typeof Run>;
      try {
        run = Run.parse(await this.call("GET", `/v1/runs/${encodeURIComponent(id)}`, null, signal));
      } catch (e) {
        if (signal?.aborted) return fail("stopped");
        return fail(`couldn't read run ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (run.status === "passed" || run.status === "failed" || run.status === "error") {
        return {
          ...base,
          startedAt: run.startedAt ?? startedAt,
          status: run.status,
          finishedAt: run.finishedAt ?? now(),
          invariants: run.status === "error" && run.invariants.length === 0 ? [{ name: "runner", ok: false, detail: run.error ?? "the world run failed" }] : run.invariants,
          metrics: run.metrics,
          reportUrl: run.reportUrl ?? null,
        };
      }
      if (Date.now() > deadline) return fail(`run ${id} still ${run.status} after the timeout`);
      try {
        await sleep(this.o.pollMs ?? 10_000, signal);
      } catch {
        return fail("stopped");
      }
    }
  }

  private async call(method: "GET" | "POST", path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.o.token) headers.authorization = `Bearer ${this.o.token}`;
    if (body !== null) headers["content-type"] = "application/json";
    const res = await (this.o.fetch ?? fetch)(`${this.o.url.replace(/\/$/, "")}${path}`, { method, headers, body: body === null ? null : JSON.stringify(body), ...(signal ? { signal } : {}) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }
}

export const provider = defineProvider({
  name: "openworld",
  provides: {
    worldCheck: (ctx) => {
      const url = ctx.options.url ?? ctx.env.OPENWORLD_URL;
      if (typeof url !== "string" || url === "") throw new Error("openworld needs world.options.url (or OPENWORLD_URL)");
      return new OpenWorldCheck({
        url,
        token: ctx.env.OPENWORLD_TOKEN ?? null,
        ...(typeof ctx.options.pollMs === "number" ? { pollMs: ctx.options.pollMs } : {}),
        ...(typeof ctx.options.timeoutMs === "number" ? { timeoutMs: ctx.options.timeoutMs } : {}),
      });
    },
  },
});
