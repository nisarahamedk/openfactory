/**
 * Rules: pure decisions over (task record, signal). No I/O, so every rule is
 * tested with scripted event orders. The task job and foreman may only do what
 * these allow.
 *
 * Fixed rules tonight:
 *  - A task starts when an issue gets the factory label, once per issue.
 *  - Our own bot's comments never wake anything (no loops); other bots' comments don't either.
 *  - Review comments on the task's PR start a review round on the SAME session.
 *  - A PR goes to review only with evidence that names its head commit.
 *  - Humans merge; the factory never merges.
 *  - Budgets: per-task spend and review rounds are capped.
 *  - A failed task is retried when a person comments on it.
 */
import { FACTORY_MARKER, type Signal, type TaskRecord, type TaskStatus } from "@openfactory/contracts";

export type RulesConfig = {
  label: string; // e.g. "factory"
  botLogins: string[]; // our own GitHub identities
  maxTaskUsd: number;
  maxReviewRounds: number;
};

export type Action =
  | { kind: "start_task" }
  | { kind: "review_round"; body: string }
  | { kind: "foreman_reply"; body: string }
  | { kind: "finalize"; outcome: "merged" | "closed"; mergeSha?: string }
  | { kind: "record_ci" }
  | { kind: "retry"; body: string }
  | { kind: "ignore"; reason: string };

const TERMINAL: TaskStatus[] = ["merged", "closed", "failed"];

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.includes(status);
}

function fromOurBot(signal: Signal, cfg: RulesConfig): boolean {
  if ("body" in signal && signal.type !== "issue_labeled" && signal.body.includes(FACTORY_MARKER)) return true;
  const login = signal.actor.login.toLowerCase();
  return cfg.botLogins.some((b) => b.toLowerCase() === login);
}

/** Decide what a signal means for the task it belongs to (`task` is null when none matches). */
export function decide(task: TaskRecord | null, signal: Signal, cfg: RulesConfig): Action {
  if (fromOurBot(signal, cfg)) return { kind: "ignore", reason: "own bot" };
  // Other bots (CI previews, linters, dependabot) comment on PRs too; only people steer or retry a task.
  if ((signal.type === "issue_comment" || signal.type === "pr_review_comment") && signal.actor.isBot)
    return { kind: "ignore", reason: "bot comment" };

  switch (signal.type) {
    case "issue_labeled":
      if (signal.label.toLowerCase() !== cfg.label.toLowerCase()) return { kind: "ignore", reason: "other label" };
      if (task && !isTerminal(task.status)) return { kind: "ignore", reason: "task already running for this issue" };
      return { kind: "start_task" };

    case "issue_comment":
      if (!task) return { kind: "ignore", reason: "no task" };
      if (task.status === "failed") return { kind: "retry", body: signal.body };
      if (isTerminal(task.status)) return { kind: "ignore", reason: `task ${task.status}` };
      // A comment on the PR conversation tab arrives as an issue comment on the PR number.
      if (task.pr && signal.issueNumber === task.pr.number) return reviewOrStop(task, signal.body, cfg);
      return { kind: "foreman_reply", body: signal.body };

    case "pr_review_comment":
      if (!task) return { kind: "ignore", reason: "no task" };
      if (task.status === "failed") return { kind: "retry", body: signal.body };
      if (isTerminal(task.status)) return { kind: "ignore", reason: `task ${task.status}` };
      return reviewOrStop(task, signal.body, cfg);

    case "pr_merged":
      if (!task) return { kind: "ignore", reason: "no task" };
      return { kind: "finalize", outcome: "merged", mergeSha: signal.mergeSha };

    case "pr_closed":
      if (!task || isTerminal(task.status)) return { kind: "ignore", reason: "no live task" };
      return { kind: "finalize", outcome: "closed" };

    case "ci_completed":
      return task ? { kind: "record_ci" } : { kind: "ignore", reason: "no task" };
  }
}

function reviewOrStop(task: TaskRecord, body: string, cfg: RulesConfig): Action {
  if (task.people.reviewRounds >= cfg.maxReviewRounds)
    return { kind: "foreman_reply", body: `${body}\n\n(Review round limit of ${cfg.maxReviewRounds} reached.)` };
  const budget = withinBudget(task, cfg);
  if (!budget.ok) return { kind: "foreman_reply", body: `${body}\n\n(${budget.reason})` };
  return { kind: "review_round", body };
}

export function withinBudget(task: TaskRecord, cfg: RulesConfig): { ok: true } | { ok: false; reason: string } {
  if (task.usage.costUsd >= cfg.maxTaskUsd)
    return { ok: false, reason: `Task budget of $${cfg.maxTaskUsd} spent ($${task.usage.costUsd.toFixed(2)}).` };
  return { ok: true };
}

/**
 * Evidence before review: the PR must exist and at least one piece of evidence must name its head commit
 * (or, when the head is unknown, any commit).
 */
export function readyForReview(task: TaskRecord): { ok: true } | { ok: false; reason: string } {
  if (!task.pr) return { ok: false, reason: "No pull request yet." };
  if (task.evidence.length === 0) return { ok: false, reason: "No evidence attached." };
  const head = task.pr.headSha;
  if (head && !task.evidence.some((e) => head.startsWith(e.commitSha) || e.commitSha.startsWith(head)))
    return { ok: false, reason: `No evidence for the PR head commit ${head.slice(0, 7)}.` };
  return { ok: true };
}

/** Allowed status transitions; the job refuses anything else. */
const NEXT: Record<TaskStatus, TaskStatus[]> = {
  received: ["preparing", "failed", "closed"],
  preparing: ["working", "failed", "closed"],
  working: ["awaiting_review", "failed", "closed", "merged"],
  awaiting_review: ["iterating", "merged", "closed", "failed"],
  iterating: ["awaiting_review", "failed", "closed", "merged"],
  merged: [],
  closed: [],
  failed: ["preparing", "iterating", "closed"],
};

export function canMove(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || NEXT[from].includes(to);
}

// ───────────────────────────── model routing ─────────────────────────────

/** One routing rule: the first rule that matches picks the worker model for a new task. */
export type ModelRoute = {
  model: string;
  /** Matches when the issue has any of these labels (case-insensitive). */
  labels?: string[];
  /** Matches when the title contains any of these words (case-insensitive). */
  keywords?: string[];
};

export type ModelRouting = {
  /** The model when no route matches (and the harness's default model). */
  default: string;
  routes: ModelRoute[];
};

/**
 * Pick the worker model for a new task. A `model:<name>` label wins over every route
 * (so a person can force a model per issue); otherwise the first matching route, else the default.
 * Pure and deterministic, so the choice is reproducible from the ledger's task_created data.
 */
export function pickModel(
  task: { title: string; labels: string[] },
  routing: ModelRouting,
): { model: string; reason: string } {
  const labels = task.labels.map((l) => l.toLowerCase());
  const forced = labels.find((l) => l.startsWith("model:"));
  if (forced) return { model: forced.slice("model:".length).trim(), reason: `label ${forced}` };
  const title = task.title.toLowerCase();
  for (const r of routing.routes) {
    const label = r.labels?.find((l) => labels.includes(l.toLowerCase()));
    if (label) return { model: r.model, reason: `label ${label}` };
    const word = r.keywords?.find((k) => new RegExp(`\\b${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(title));
    if (word) return { model: r.model, reason: `title mentions "${word}"` };
  }
  return { model: routing.default, reason: "default" };
}
