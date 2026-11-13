/**
 * The task record is a projection of the event log. `apply` is pure so the
 * same events always give the same record, in tests, in replays and in
 * production.
 */
import {
  Evidence,
  MergeRisk,
  RepoRef,
  Outcome,
  Score,
  TaskStatus,
  Usage,
  WorldCheckResult,
  type LedgerEvent,
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
  /** `repo` is set for a PR in another repo of the task's scope; without it, the primary PR. */
  pr_opened: z.object({ number: z.number().int(), url: z.string(), headSha: z.string().nullable(), repo: RepoRef.optional() }),
  /** The repos this task works in, primary first (planned at intake). */
  scope_planned: z.object({ repos: z.array(RepoRef).min(1), reason: z.string() }),
  /** Which factory version served this task while a candidate rolls out to a share of new tasks. */
  version_routed: z.object({ version: z.string(), arm: z.enum(["stable", "candidate"]), share: z.number() }),
  /** Merge-risk assessment of the primary PR at a head. */
  merge_risk: MergeRisk,
  /** The team factory a task runs on (its asker's team, else the repo's team, else "default"). */
  factory_assigned: z.object({ factory: z.string(), team: z.string().nullable() }),
  /** A new PR head. `byFactory: false` means someone else pushed between agent turns (autonomy = merged with none). */
  pushed: z.object({ sha: z.string(), byFactory: z.boolean().optional(), repo: RepoRef.optional() }),
  /** PR size at a head (recorded when the PR opens, on each factory push, and at merge). */
  pr_stats: z.object({ headSha: z.string(), additions: z.number().int(), deletions: z.number().int(), changedFiles: z.number().int() }),
  /** One agent turn's update stream, saved as JSONL in the EvidenceStore. */
  transcript_saved: z.object({ turn: z.number().int(), key: z.string(), url: z.string(), lines: z.number().int() }),
  /** Someone stopped the task through the API. */
  cancelled: z.object({ by: z.string(), reason: z.string().optional() }),
  evidence_added: z.object({ evidence: Evidence }),
  comment_received: z.object({ author: z.string(), isBot: z.boolean(), on: z.enum(["issue", "pr"]) }),
  review_round_started: z.object({ comments: z.number().int() }),
  ci_completed: z.object({ headSha: z.string(), conclusion: z.string(), name: z.string() }),
  foreman_replied: z.object({ url: z.string().optional(), usage: Usage.optional() }),
  /** Agent spend corrected to what the model gateway billed the task's key (gatewayUsd is its running total). */
  cost_adjusted: z.object({ deltaUsd: z.number(), gatewayUsd: z.number() }),
  score_added: z.object({ score: Score }),
  outcome_added: z.object({ outcome: Outcome }),
  error: z.object({ message: z.string(), stage: z.string() }),
  /** Network requests from the task's sandbox, as the egress proxy saw them (aggregated per host and window). */
  egress: z.object({ host: z.string(), allowed: z.boolean(), count: z.number().int().positive(), from: z.string(), to: z.string() }),
  /** A signal that changed nothing on the record by itself (merge/close); kept for de-duplication and the timeline. */
  signal_received: z.object({ type: z.string(), actor: z.string() }),
  /** An OpenWorld run of a PR head (dedupe on world:<taskId>:<headSha>). Adds score checks.world. */
  world_check: WorldCheckResult,
  /** A person wrote to the task from the factory app (also posted where the task lives). */
  message_received: z.object({ author: z.string(), text: z.string(), url: z.string().nullable() }),
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
  requestedBy?: string | null;
  labels?: string[];
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
    repos: [],
    versionArm: null,
    risk: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    people: { comments: 0, reviewRounds: 0 },
    evidence: [],
    scores: [],
    outcomes: [],
    requestedBy: input.requestedBy ?? null,
    labels: input.labels ?? [],
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

const sameRepo = (a: RepoRef, b: RepoRef) => repoKey(a) === repoKey(b);

/** Keep repos[0] equal to the primary repo, branch and PR. */
function withPrimary(r: TaskRecord): TaskRecord {
  const rest = (r.repos ?? []).filter((x) => !sameRepo(x.repo, r.source.repo));
  return { ...r, repos: [{ repo: r.source.repo, branch: r.branch, pr: r.pr }, ...rest] };
}

type TaskRepoT = NonNullable<TaskRecord["repos"]>[number];

function setRepo(r: TaskRecord, repo: RepoRef, change: (x: TaskRepoT) => TaskRepoT): TaskRecord {
  const cur = r.repos ?? [];
  const repos = cur.some((x) => sameRepo(x.repo, repo)) ? cur : [...cur, { repo, branch: r.branch, pr: null }];
  return { ...r, repos: repos.map((x) => (sameRepo(x.repo, repo) ? change(x) : x)) };
}

/** Apply one event. Unknown event types only move `updatedAt`. */
export function apply(record: TaskRecord, event: LedgerEvent): TaskRecord {
  // Records written before repos/versionArm/risk existed lack them.
  const r: TaskRecord = { ...record, repos: record.repos ?? [], versionArm: record.versionArm ?? null, risk: record.risk ?? null, updatedAt: event.at };
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
    case "branch_set": {
      const branch = (d as EventDataOf<"branch_set">).branch;
      return withPrimary({ ...r, branch, repos: (r.repos ?? []).map((x) => ({ ...x, branch })) });
    }
    case "scope_planned": {
      const e = d as EventDataOf<"scope_planned">;
      const repos = e.repos.map((repo) => (r.repos ?? []).find((x) => sameRepo(x.repo, repo)) ?? { repo, branch: r.branch, pr: null });
      return withPrimary({ ...r, repos });
    }
    case "version_routed": {
      const e = d as EventDataOf<"version_routed">;
      return { ...r, factoryVersion: e.version, versionArm: e.arm };
    }
    case "factory_assigned":
      return { ...r, factory: (d as EventDataOf<"factory_assigned">).factory };
    case "merge_risk":
      return { ...r, risk: d as EventDataOf<"merge_risk"> };
    case "cost_adjusted":
      return { ...r, usage: addUsage(r.usage, { inputTokens: 0, outputTokens: 0, costUsd: (d as EventDataOf<"cost_adjusted">).deltaUsd }) };
    case "turn_finished":
      return { ...r, usage: addUsage(r.usage, (d as EventDataOf<"turn_finished">).usage) };
    case "foreman_replied": {
      const u = (d as EventDataOf<"foreman_replied">).usage;
      return u ? { ...r, usage: addUsage(r.usage, u) } : r;
    }
    case "pr_opened": {
      const e = d as EventDataOf<"pr_opened">;
      const pr = { number: e.number, url: e.url, headSha: e.headSha };
      if (e.repo && !sameRepo(e.repo, r.source.repo)) return setRepo(r, e.repo, (x) => ({ ...x, pr }));
      return withPrimary({ ...r, pr });
    }
    case "pushed": {
      const e = d as EventDataOf<"pushed">;
      if (e.repo && !sameRepo(e.repo, r.source.repo)) return setRepo(r, e.repo, (x) => (x.pr ? { ...x, pr: { ...x.pr, headSha: e.sha } } : x));
      return r.pr ? withPrimary({ ...r, pr: { ...r.pr, headSha: e.sha } }) : r;
    }
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
    case "world_check": {
      const w = d as EventDataOf<"world_check">;
      const score = { scorer: "checks.world", scorerVersion: "1", value: w.status === "passed" ? 1 : 0, label: w.status, reason: `${w.world}, ${w.simDays} simulated days: ${w.invariants.filter((i) => !i.ok).map((i) => i.name).join(", ") || "every invariant held"}`, at: w.finishedAt };
      return { ...r, worldChecks: [...(r.worldChecks ?? []), w], scores: [...r.scores.filter((x) => x.scorer !== "checks.world"), score] };
    }
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
