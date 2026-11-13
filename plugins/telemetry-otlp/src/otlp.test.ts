import { describe, expect, it } from "vitest";
import { fixtureRecord } from "@openfactory/conformance";
import type { LedgerEvent, TaskRecord } from "@openfactory/contracts";
import { buildTaskSpans, OtlpTaskExporter, otlpFromEnv, parseOtlpHeaders, redact, traceIdFor, type OtlpSpan } from "./index.js";

// Not run against the MetricsSink conformance suite on purpose: a trace is not an upserted
// row. Open tasks have no root span yet, and spans are appended, never updated.

const ev = (type: string, at: string, data: Record<string, unknown> = {}): LedgerEvent => ({ taskId: "task_t1", at, type, data });
const merged = (): TaskRecord =>
  fixtureRecord({
    id: "task_t1",
    status: "merged",
    title: "Fix login for dana@example.com",
    ask: "token=ghp_abcdefghijklmnopqrstuvwxyz0123",
    createdAt: "2026-11-13T10:00:00Z",
    updatedAt: "2026-11-13T14:00:00Z",
    outcomes: [{ kind: "reverted", source: "dxfake", detail: "revert", at: "2026-11-14T00:00:00Z", arrivedAt: "2026-11-14T01:00:00Z" }],
  });
const log: LedgerEvent[] = [
  ev("turn_started", "2026-11-13T10:01:00Z", { reason: "intake" }),
  ev("turn_finished", "2026-11-13T10:20:00Z", { reason: "intake", usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.25 }, stopReason: "end_turn", summary: "used sk-ant-abcdefghijklmnop1234" }),
  ev("pr_opened", "2026-11-13T10:21:00Z", { number: 4 }),
  ev("egress", "2026-11-13T10:10:00Z", { host: "evil.example", allowed: false, count: 2 }),
  ev("comment_received", "2026-11-13T11:00:00Z", { isBot: false, on: "pr" }),
  ev("turn_started", "2026-11-13T11:01:00Z", { reason: "review" }),
  ev("turn_finished", "2026-11-13T11:10:00Z", { reason: "review", usage: { inputTokens: 50, outputTokens: 5, costUsd: 0.1 }, stopReason: "end_turn" }),
  ev("pushed", "2026-11-13T12:00:00Z", { sha: "x", byFactory: false }),
  ev("status_changed", "2026-11-13T13:00:00Z", { from: "awaiting_review", to: "merged" }),
];
const opts = { includeTitles: true, includeText: false, extraRedactions: [] };
const a = (s: OtlpSpan, k: string) => s.attributes.find((x) => x.key === k)?.value;

describe("task trace", () => {
  it("builds task → intake/review round → agent turn, with deterministic ids", () => {
    const spans = buildTaskSpans(merged(), log, opts);
    const by = (n: string) => spans.filter((s) => s.name === n);
    const root = by("factory.task")[0]!;
    expect(root.parentSpanId).toBeUndefined();
    expect(root.traceId).toBe(traceIdFor("task_t1"));
    expect(root.endTimeUnixNano).toBe(`${BigInt(Date.parse("2026-11-13T13:00:00Z")) * 1_000_000n}`);
    expect(root.status.code).toBe(1);
    const intake = by("factory.intake")[0]!;
    const round = by("factory.review_round")[0]!;
    const [t1, t2] = by("agent.turn");
    expect(t1!.parentSpanId).toBe(intake.spanId);
    expect(t2!.parentSpanId).toBe(round.spanId);
    expect(round.startTimeUnixNano).toBe(`${BigInt(Date.parse("2026-11-13T11:00:00Z")) * 1_000_000n}`); // starts at the review comment
    expect(a(t1!, "gen_ai.usage.input_tokens")).toEqual({ intValue: "100" });
    expect(a(t1!, "factory.cost_usd")).toEqual({ doubleValue: 0.25 });
    expect(by("factory.finalize")).toHaveLength(1);
    expect(by("factory.outcome.reverted")[0]!.status.code).toBe(2);
    expect(root.events.map((e) => e.name)).toEqual(["egress_denied", "human_push"]);
    expect(buildTaskSpans(merged(), log, opts).map((s) => s.spanId)).toEqual(spans.map((s) => s.spanId));
  });

  it("redacts secrets and leaves free text out unless asked", () => {
    const off = JSON.stringify(buildTaskSpans(merged(), log, opts));
    expect(off).not.toContain("ghp_");
    expect(off).not.toContain("sk-ant");
    expect(off).not.toContain("dana@example.com");
    expect(off).toContain("Fix login for [REDACTED]");
    const on = JSON.stringify(buildTaskSpans(merged(), log, { ...opts, includeText: true }));
    expect(on).toContain("factory.task.ask");
    expect(on).not.toContain("ghp_abc");
    expect(on).not.toContain("sk-ant-abc");
    expect(redact("Authorization: Bearer abcdefghijk123")).toBe("Authorization: [REDACTED]");
  });

  it("an open task sends finished turns only, without a root span", () => {
    const open = fixtureRecord({ id: "task_t1", status: "working", createdAt: "2026-11-13T10:00:00Z" });
    const names = buildTaskSpans(open, log.slice(0, 2), opts).map((s) => s.name);
    expect(names).toEqual(["agent.turn"]);
  });
});

describe("OtlpTaskExporter", () => {
  it("POSTs OTLP/JSON to /v1/traces once per span, then only new spans", async () => {
    const posts: Array<{ url: string; headers: Headers; body: { resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }> } }> = [];
    const fake: typeof fetch = async (input, init) => {
      posts.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 200 });
    };
    let events = log.slice(0, 2);
    let record: TaskRecord = fixtureRecord({ id: "task_t1", status: "working", createdAt: "2026-11-13T10:00:00Z" });
    const x = otlpFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/", OTEL_EXPORTER_OTLP_HEADERS: "dd-api-key=abc%3D" }, async () => events)!;
    (x as unknown as { cfg: { fetch: typeof fetch } }).cfg.fetch = fake;
    await x.writeTasks([record]);
    await x.writeTasks([record]); // nothing new
    events = log;
    record = merged();
    await x.writeTasks([record]);
    expect(posts).toHaveLength(2);
    expect(posts[0]!.url).toBe("http://collector:4318/v1/traces");
    expect(posts[0]!.headers.get("dd-api-key")).toBe("abc=");
    const second = posts[1]!.body.resourceSpans[0]!.scopeSpans[0]!.spans.map((s) => s.name);
    expect(second.filter((n) => n === "agent.turn")).toHaveLength(1); // turn 1 was already sent
    expect(second).toContain("factory.task");
  });

  it("is off without an endpoint, and surfaces collector errors", async () => {
    expect(otlpFromEnv({}, async () => [])).toBeNull();
    const x = new OtlpTaskExporter({ endpoint: "http://c", headers: {}, serviceName: "f", events: async () => log, fetch: async () => new Response("nope", { status: 503 }) });
    await expect(x.writeTasks([merged()])).rejects.toThrow(/503/);
    expect(parseOtlpHeaders("a=1, b = x%20y")).toEqual({ a: "1", b: "x y" });
  });
});
