/**
 * The task record is a projection of the event log. `apply` is pure so the
 * same events always give the same record, in tests, in replays and in
 * production.
 */
import {
  Evidence,
  Outcome,
  Score,
  TaskStatus,
  Usage,
  type LedgerEvent,
  type RepoRef,
  type TaskId,
  type TaskRecord,
} from "@openfactory/contracts";
import { z } from "zod";

/** Event types the ledger understands, with the shape of their `data`. */
export const EventData = {
  task_created: z.object({}).passthrough(),
  status_changed: z.object({ from: TaskStatus, to: TaskStatus, reason: z.string().optional() }),
  session_started: z.object({ sessionId: z.string() }),
  environment_attached: z.object({ plugin: z.string(), name: z.string() }),
  workspace_attached: z.object({ plugin: z.string(), id: z.string() }),
  branch_set: z.object({ branch: z.string() }),
  turn_started: z.object({ reason: z.enum(["intake", "review", "steer"]) }),
  turn_finished: z.object({
    reason: z.enum(["intake", "review", "steer"]),
    usage: Usage,
    stopReason: z.string(),
    summary: z.string().optional(),
  }),
  pr_opened: z.object({ number: z.number().int(), url: z.string(), headSha: z.string().nullable() }),
  pushed: z.object({ sha: z.string() }),
  evidence_added: z.object({ evidence: Evidence }),
  comment_received: z.object({ author: z.string(), isBot: z.boolean(), on: z.enum(["issue", "pr"]) }),
  review_round_started: z.object({ comments: z.number().int() }),
  ci_completed: z.object({ headSha: z.string(), conclusion: z.string(), name: z.string() }),
  foreman_replied: z.object({ url: z.string().optional(), usage: Usage.optional() }),
  score_added: z.object({ score: Score }),
  outcome_added: z.object({ outcome: Outcome }),
  error: z.object({ message: z.string(), stage: z.string() }),
  /** A signal that changed nothing on the record by itself (merge/close); kept for de-duplication and the timeline. */
  signal_received: z.object({ type: z.string(), actor: z.string() }),
} as const;
export type EventType = keyof typeof EventData;
export type EventDataOf<T extends EventType> = z.infer<(typeof EventData)[T]>;

export type NewTask = {
  id: TaskId;
  factoryVersion: string;
  source: TaskRecord["source"];
  title: string;
  ask: string;
  harness: { name: string; model: string };
  at: string;
};

export function newRecord(input: NewTask): TaskRecord {
  return {
    id: input.id,
    factoryVersion: input.factoryVersion,
    source: input.source,
    title: input.title,
    ask: input.ask,
    status: "received",
    harness: input.harness,
    harnessSessionId: null,
    environment: null,
    workspace: null,
    branch: null,
    pr: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    people: { comments: 0, reviewRounds: 0 },
    evidence: [],
    scores: [],
    outcomes: [],
    createdAt: input.at,
    updatedAt: input.at,
  };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: Math.round((a.costUsd + b.costUsd) * 1e6) / 1e6,
  };
}

/** Apply one event. Unknown event types only move `updatedAt`. */
export function apply(record: TaskRecord, event: LedgerEvent): TaskRecord {
  const r: TaskRecord = { ...record, updatedAt: event.at };
  const type = event.type as EventType;
  const schema = EventData[type];
  if (!schema) return r;
  const parsed = schema.safeParse(event.data);
  if (!parsed.success) return r;
  const d = parsed.data as Record<string, unknown>;
  switch (type) {
    case "status_changed":
      return { ...r, status: (d as EventDataOf<"status_changed">).to };
    case "session_started":
      return { ...r, harnessSessionId: (d as EventDataOf<"session_started">).sessionId };
    case "environment_attached": {
      const e = d as EventDataOf<"environment_attached">;
      return { ...r, environment: { plugin: e.plugin, name: e.name } };
    }
    case "workspace_attached": {
      const e = d as EventDataOf<"workspace_attached">;
      return { ...r, workspace: { plugin: e.plugin, id: e.id } };
    }
    case "branch_set":
      return { ...r, branch: (d as EventDataOf<"branch_set">).branch };
    case "turn_finished":
      return { ...r, usage: addUsage(r.usage, (d as EventDataOf<"turn_finished">).usage) };
    case "foreman_replied": {
      const u = (d as EventDataOf<"foreman_replied">).usage;
      return u ? { ...r, usage: addUsage(r.usage, u) } : r;
    }
    case "pr_opened": {
      const e = d as EventDataOf<"pr_opened">;
      return { ...r, pr: { number: e.number, url: e.url, headSha: e.headSha } };
    }
    case "pushed":
      return r.pr ? { ...r, pr: { ...r.pr, headSha: (d as EventDataOf<"pushed">).sha } } : r;
    case "evidence_added":
      return { ...r, evidence: [...r.evidence, (d as EventDataOf<"evidence_added">).evidence] };
    case "comment_received":
      return (d as EventDataOf<"comment_received">).isBot
        ? r
        : { ...r, people: { ...r.people, comments: r.people.comments + 1 } };
    case "review_round_started":
      return { ...r, people: { ...r.people, reviewRounds: r.people.reviewRounds + 1 } };
    case "score_added": {
      const s = (d as EventDataOf<"score_added">).score;
      const rest = r.scores.filter((x) => !(x.scorer === s.scorer && x.scorerVersion === s.scorerVersion));
      return { ...r, scores: [...rest, s] };
    }
    case "outcome_added":
      return { ...r, outcomes: [...r.outcomes, (d as EventDataOf<"outcome_added">).outcome] };
    default:
      return r;
  }
}

export function project(initial: TaskRecord, events: LedgerEvent[]): TaskRecord {
  return events.reduce(apply, initial);
}

export function repoKey(repo: RepoRef): string {
  return `${repo.host}:${repo.owner}/${repo.name}`.toLowerCase();
}
