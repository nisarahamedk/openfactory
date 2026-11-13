import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@openfactory/contracts";
import { OpenWorldCheck, provider } from "./index.js";

const input = { task: {} as TaskRecord, repo: { host: "github" as const, owner: "acme", name: "pay" }, headSha: "abc", world: "payments-30d", simDays: 30 };

function runner(statuses: string[], extra: Record<string, unknown> = {}) {
  const seen: string[] = [];
  let i = 0;
  const f: typeof fetch = async (url, init) => {
    seen.push(`${init?.method} ${new URL(String(url)).pathname} ${init?.body ?? ""}`);
    if (init?.method === "POST") return new Response(JSON.stringify({ id: "run_1" }), { status: 202 });
    const status = statuses[Math.min(i++, statuses.length - 1)];
    return new Response(JSON.stringify({ id: "run_1", status, startedAt: "2026-11-13T00:00:00Z", finishedAt: "2026-11-13T00:03:00Z", ...extra }), { status: 200 });
  };
  return { f, seen };
}

describe("OpenWorldCheck", () => {
  it("starts a run and polls until it finishes", async () => {
    const { f, seen } = runner(["queued", "running", "failed"], { invariants: [{ name: "money conserved", ok: false, detail: "2 refunds paid twice" }], metrics: [{ name: "p95 ms", value: 120, unit: "ms" }], reportUrl: "https://ow/r/1" });
    const r = await new OpenWorldCheck({ url: "https://ow/", fetch: f, sleep: async () => {} }).run(input);
    expect(r).toMatchObject({ status: "failed", world: "payments-30d", headSha: "abc", simDays: 30, reportUrl: "https://ow/r/1" });
    expect(r.invariants[0]).toEqual({ name: "money conserved", ok: false, detail: "2 refunds paid twice" });
    expect(seen[0]).toBe('POST /v1/runs {"repo":"acme/pay","sha":"abc","world":"payments-30d","simDays":30}');
    expect(seen.filter((s) => s.startsWith("GET"))).toHaveLength(3);
  });

  it("turns an unreachable runner or a timeout into status error, never a throw", async () => {
    const down: typeof fetch = async () => new Response("no", { status: 503 });
    const r = await new OpenWorldCheck({ url: "https://ow", fetch: down }).run(input);
    expect(r.status).toBe("error");
    expect(r.invariants[0]!.detail).toContain("503");
    const { f } = runner(["running"]);
    const slow = await new OpenWorldCheck({ url: "https://ow", fetch: f, sleep: async () => {}, timeoutMs: -1 }).run(input);
    expect(slow.status).toBe("error");
    expect(slow.invariants[0]!.detail).toContain("timeout");
  });

  it("needs a runner url", () => {
    expect(() => provider.provides.worldCheck!({ options: {}, env: {}, log: () => {} })).toThrow("needs world.options.url");
  });
});
