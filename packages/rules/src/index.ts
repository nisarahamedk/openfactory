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

// ───────────────────────────── factory version rollout ─────────────────────────────

export type Rollout = {
  stable: string;
  /** null: no candidate rolling out. */
  candidate: string | null;
  /** Share of new tasks (0..1) that get the candidate. */
  share: number;
};

/** Stable hash of a string to [0, 1), so a task's arm is reproducible from its signal id. */
export function unitHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 2 ** 32;
}

/** Which factory version serves a new task. Deterministic per key (the signal id). */
export function pickVersion(key: string, rollout: Rollout): { version: string; arm: "stable" | "candidate" } {
  if (rollout.candidate && rollout.share > 0 && unitHash(key) < rollout.share) return { version: rollout.candidate, arm: "candidate" };
  return { version: rollout.stable, arm: "stable" };
}

// ───────────────────────────── merge risk ─────────────────────────────

export type RiskConfig = {
  /** Path patterns (regex source) that make a change riskier: migrations, auth, billing, CI, infra... */
  riskyPaths: string[];
  /** Lines changed above which a PR is medium / high risk. */
  mediumLines: number;
  highLines: number;
  /** Path patterns (regex source) that are safe on their own (docs...): a PR touching only these is low risk unless CI fails. */
  safePaths?: string[];
};

/** A path glob (`src/payments/**`, `**\/*.md`) as a regex source. */
export function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return `^${out}$`;
}

export const DEFAULT_RISK: RiskConfig = {
  riskyPaths: [
    "(^|/)migrations?/",
    "(^|/)drizzle/",
    "\\.sql$",
    "(^|/)(auth|session|permissions?)[/.]",
    "(billing|payment|stripe|invoice)",
    "^\\.github/workflows/",
    "^(infra|deploy|terraform)/",
    "(^|/)(package\\.json|pnpm-lock\\.yaml|package-lock\\.json)$",
    "(^|/)wrangler\\.(toml|jsonc?)$",
  ],
  mediumLines: 200,
  highLines: 800,
};

export type RiskInput = {
  headSha: string;
  additions: number;
  deletions: number;
  files: string[];
  /** Latest CI conclusions for the head (empty: unknown). */
  ci: string[];
  evidenceForHead: boolean;
  reviewRounds: number;
};

/**
 * Merge risk for a PR head, from facts a reviewer would weigh: size, sensitive paths, CI, evidence and churn.
 * Pure, so the same facts always give the same label; the reasons are shown on the PR.
 */
export function mergeRisk(input: RiskInput, cfg: RiskConfig = DEFAULT_RISK): { level: "low" | "medium" | "high"; reasons: string[]; headSha: string } {
  const reasons: string[] = [];
  let score = 0;
  const lines = input.additions + input.deletions;
  if (lines >= cfg.highLines) {
    score += 2;
    reasons.push(`${lines} lines changed`);
  } else if (lines >= cfg.mediumLines) {
    score += 1;
    reasons.push(`${lines} lines changed`);
  }
  const patterns = cfg.riskyPaths.map((p) => new RegExp(p, "i"));
  const risky = input.files.filter((f) => patterns.some((p) => p.test(f)));
  if (risky.length) {
    score += 2;
    reasons.push(`touches ${risky.slice(0, 3).join(", ")}${risky.length > 3 ? ` and ${risky.length - 3} more` : ""}`);
  }
  if (input.ci.some((c) => c === "failure" || c === "timed_out")) {
    score += 2;
    reasons.push("CI failing on this head");
  }
  if (!input.evidenceForHead) {
    score += 1;
    reasons.push("no evidence for this head");
  }
  if (input.reviewRounds >= 3) {
    score += 1;
    reasons.push(`${input.reviewRounds} review rounds`);
  }
  const safe = (cfg.safePaths ?? []).map((p) => new RegExp(p, "i"));
  const ciFailed = input.ci.some((c) => c === "failure" || c === "timed_out");
  if (safe.length && input.files.length && !ciFailed && input.files.every((f) => safe.some((p) => p.test(f)))) {
    return { level: "low", reasons: ["only touches paths this factory treats as safe"], headSha: input.headSha };
  }
  const level = score >= 3 ? "high" : score >= 1 ? "medium" : "low";
  if (level === "low") reasons.push(`${lines} lines, no sensitive paths, evidence for head`);
  return { level, reasons, headSha: input.headSha };
}

// ───────────────────────────── scope ─────────────────────────────

export type RepoName = { owner: string; name: string };

/**
 * The repos a new task works in: its own repo first, plus any other factory repo the issue names
 * (`owner/name` in the text, or a `repo:<name>` label). Deterministic; a planner can widen it later.
 */
export function planScope(
  primary: RepoName,
  issue: { title: string; body: string; labels: string[] },
  known: RepoName[],
): { repos: RepoName[]; reason: string } {
  const key = (r: RepoName) => `${r.owner}/${r.name}`.toLowerCase();
  const text = `${issue.title}\n${issue.body}`.toLowerCase();
  const labels = issue.labels.map((l) => l.toLowerCase());
  const extra = known.filter((r) => {
    if (key(r) === key(primary)) return false;
    if (labels.includes(`repo:${r.name.toLowerCase()}`) || labels.includes(`repo:${key(r)}`)) return true;
    return new RegExp(`(^|[^\\w/.-])${key(r).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w/.-])`).test(text);
  });
  return extra.length
    ? { repos: [primary, ...extra], reason: `issue names ${extra.map(key).join(", ")}` }
    : { repos: [primary], reason: "single repo" };
}
