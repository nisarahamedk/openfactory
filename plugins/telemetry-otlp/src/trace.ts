import { createHash } from "node:crypto";
import type { LedgerEvent, TaskRecord, TaskStatus } from "@openfactory/contracts";
import { redact } from "./redact.js";

/**
 * Turns one task's ledger into OTLP spans (OTLP/JSON, protocol 1.x):
 *
 *   factory.task                      created → merged/closed/failed
 *   ├─ factory.intake                 created → PR opened (or end)
 *   │   └─ agent.turn                 one per intake/steer turn
 *   ├─ factory.review_round N         review comment → turn finished
 *   │   └─ agent.turn
 *   ├─ factory.finalize               terminal status (instant)
 *   └─ factory.outcome.<kind>         late outcomes (reverted, incident...), instant
 *
 * IDs are derived from the task id, so re-exporting gives the same spans and a
 * restarted factory can't fork a trace. Spans still open are not built.
 */

export type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
export type KeyValue = { key: string; value: AnyValue };
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 1;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  events: Array<{ timeUnixNano: string; name: string; attributes: KeyValue[] }>;
  status: { code: 0 | 1 | 2; message?: string };
}

export interface TraceOptions {
  /** Send task titles (redacted). Default true. */
  includeTitles: boolean;
  /** Send the ask and turn summaries (redacted). Default false. */
  includeText: boolean;
  extraRedactions: RegExp[];
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set(["merged", "closed", "failed"]);

const hex = (s: string, bytes: number) => createHash("sha256").update(s).digest("hex").slice(0, bytes * 2);
export const traceIdFor = (taskId: string) => hex(`trace:${taskId}`, 16);
const spanId = (taskId: string, name: string) => hex(`span:${taskId}:${name}`, 8);
const nanos = (iso: string) => `${BigInt(Date.parse(iso)) * 1_000_000n}`;

function attr(key: string, v: string | number | boolean | null | undefined): KeyValue[] {
  if (v === null || v === undefined) return [];
  if (typeof v === "string") return [{ key, value: { stringValue: v } }];
  if (typeof v === "boolean") return [{ key, value: { boolValue: v } }];
  return [{ key, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } }];
}

const str = (d: Record<string, unknown>, k: string) => (typeof d[k] === "string" ? (d[k] as string) : null);
const num = (d: unknown, k: string) => (typeof d === "object" && d !== null && typeof (d as Record<string, unknown>)[k] === "number" ? ((d as Record<string, unknown>)[k] as number) : null);

export function buildTaskSpans(record: TaskRecord, events: readonly LedgerEvent[], opts: TraceOptions): OtlpSpan[] {
  const text = (s: string, max = 2000) => redact(s, opts.extraRedactions).slice(0, max);
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const traceId = traceIdFor(record.id);
  const rootId = spanId(record.id, "task");
  const spans: OtlpSpan[] = [];
  const span = (key: string, name: string, start: string, end: string, parent: string | null, attributes: KeyValue[], status: OtlpSpan["status"] = { code: 0 }): OtlpSpan => {
    const s: OtlpSpan = { traceId, spanId: key === "task" ? rootId : spanId(record.id, key), name, kind: 1, startTimeUnixNano: nanos(start), endTimeUnixNano: nanos(end), attributes, events: [], status };
    if (parent !== null) s.parentSpanId = parent;
    spans.push(s);
    return s;
  };

  const prOpened = sorted.find((e) => e.type === "pr_opened")?.at ?? null;
  const terminalAt = TERMINAL.has(record.status) ? ([...sorted].reverse().find((e) => e.type === "status_changed" && TERMINAL.has(e.data.to as TaskStatus))?.at ?? record.updatedAt) : null;

  // Phases: intake, then one review round per review turn.
  const intakeEnd = prOpened ?? terminalAt;
  const intakeId = spanId(record.id, "intake");
  if (intakeEnd !== null) span("intake", "factory.intake", record.createdAt, intakeEnd, rootId, [...attr("factory.pr_opened", prOpened !== null)]);

  let round = 0;
  let lastComment: string | null = null;
  let turnStart: { at: string; reason: string } | null = null;
  let turnN = 0;
  for (const e of sorted) {
    if (e.type === "comment_received" && e.data.isBot !== true) lastComment = e.at;
    if (e.type === "turn_started") turnStart = { at: e.at, reason: str(e.data, "reason") ?? "intake" };
    if (e.type !== "turn_finished") continue;
    turnN++;
    const reason = str(e.data, "reason") ?? turnStart?.reason ?? "intake";
    const start = turnStart?.at ?? e.at;
    let parent = intakeId;
    if (reason === "review") {
      round++;
      const roundStart = lastComment !== null && Date.parse(lastComment) <= Date.parse(start) ? lastComment : start;
      parent = span(`review:${round}`, "factory.review_round", roundStart, e.at, rootId, [...attr("factory.review_round", round)]).spanId;
    }
    const usage = e.data.usage;
    const stop = str(e.data, "stopReason");
    const summary = str(e.data, "summary");
    span(
      `turn:${turnN}`,
      "agent.turn",
      start,
      e.at,
      parent,
      [
        ...attr("factory.turn.number", turnN),
        ...attr("factory.turn.reason", reason),
        ...attr("gen_ai.request.model", record.harness.model),
        ...attr("gen_ai.usage.input_tokens", num(usage, "inputTokens")),
        ...attr("gen_ai.usage.output_tokens", num(usage, "outputTokens")),
        ...attr("factory.cost_usd", num(usage, "costUsd")),
        ...attr("factory.stop_reason", stop),
        ...(opts.includeText && summary ? attr("factory.turn.summary", text(summary)) : []),
      ],
      stop === "refusal" || stop === "error" ? { code: 2, message: stop } : { code: 0 },
    );
    turnStart = null;
  }

  // Late outcomes are their own instant spans, so they can arrive after the root was sent.
  for (const o of record.outcomes) {
    if (o.kind === "merged" || o.kind === "closed_unmerged") continue;
    span(`outcome:${o.kind}:${o.at}`, `factory.outcome.${o.kind}`, o.at, o.at, rootId, [
      ...attr("factory.outcome.kind", o.kind),
      ...attr("factory.outcome.source", o.source),
      ...attr("factory.outcome.learned_at", o.arrivedAt),
      ...(opts.includeText ? attr("factory.outcome.detail", text(o.detail, 500)) : []),
    ], { code: 2, message: o.kind });
  }

  if (terminalAt === null) return spans;

  span("finalize", "factory.finalize", terminalAt, terminalAt, rootId, [...attr("factory.status", record.status)]);
  const root = span(
    "task",
    "factory.task",
    record.createdAt,
    terminalAt,
    null,
    [
      ...attr("factory.task.id", record.id),
      ...attr("factory.version", record.factoryVersion),
      ...attr("factory.status", record.status),
      ...attr("factory.source.kind", record.source.kind),
      ...attr("factory.repo", `${record.source.repo.owner}/${record.source.repo.name}`),
      ...attr("factory.harness", record.harness.name),
      ...attr("gen_ai.request.model", record.harness.model),
      ...attr("gen_ai.usage.input_tokens", record.usage.inputTokens),
      ...attr("gen_ai.usage.output_tokens", record.usage.outputTokens),
      ...attr("factory.cost_usd", record.usage.costUsd),
      ...attr("factory.review_rounds", record.people.reviewRounds),
      ...attr("factory.pr.number", record.pr?.number ?? null),
      ...(opts.includeTitles ? attr("factory.task.title", text(record.title, 300)) : []),
      ...(opts.includeText ? attr("factory.task.ask", text(record.ask)) : []),
      ...record.scores.flatMap((s) => attr(`factory.score.${s.scorer}`, s.value)),
    ],
    record.status === "merged" ? { code: 1 } : { code: 2, message: record.status },
  );
  for (const e of sorted) {
    if (e.type === "ci_completed")
      root.events.push({ timeUnixNano: nanos(e.at), name: "ci_completed", attributes: [...attr("ci.name", str(e.data, "name")), ...attr("ci.conclusion", str(e.data, "conclusion"))] });
    else if (e.type === "egress" && e.data.allowed === false)
      root.events.push({ timeUnixNano: nanos(e.at), name: "egress_denied", attributes: [...attr("net.peer.name", str(e.data, "host")), ...attr("factory.egress.count", num(e.data, "count"))] });
    else if (e.type === "error")
      root.events.push({ timeUnixNano: nanos(e.at), name: "error", attributes: [...attr("factory.stage", str(e.data, "stage")), ...attr("error.message", text(str(e.data, "message") ?? "", 500))] });
    else if (e.type === "pushed" && e.data.byFactory === false) root.events.push({ timeUnixNano: nanos(e.at), name: "human_push", attributes: [] });
  }
  return spans;
}
