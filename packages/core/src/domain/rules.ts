/**
 * Pure rules: no I/O, no clock, no ids. Use cases load state, ask these, and act on the answer.
 */
import type { OrgState, OrgTeam, RepoRef, RolloutState, SetupStep, TaskRecord, Team } from "@openfactory/contracts";
import { fail, errors } from "./errors.js";
import { roleAtLeast, type Actor, type Role } from "./actor.js";
import type { RiskTier } from "@openfactory/contract";

// ───────────────────────────── authorization ─────────────────────────────

/** What an operation needs: the lowest role that may run it and its risk tier (the-stack P9). */
export type Requirement = { audience: Role; risk: RiskTier };

/**
 * May this actor, holding `role`, run an operation with these requirements? Agents never run irreversible
 * operations on their own: a person does those (P9: reversible beats approve; irreversible needs a person).
 */
export function decide(actor: Actor, role: Role, need: Requirement): { ok: true } | { ok: false; reason: "role" | "agent_risk" } {
  if (!roleAtLeast(role, need.audience)) return { ok: false, reason: "role" };
  if (actor.agent !== null && need.risk === "irreversible") return { ok: false, reason: "agent_risk" };
  return { ok: true };
}

/**
 * The role a person holds. With nobody set up in the org yet (a fresh install, or one configured only by
 * factory.yaml), whoever holds the operator credential runs it, so everyone is an admin until people exist.
 */
export function roleOfPerson(person: { role: Role } | null, orgHasPeople: boolean): Role {
  if (!orgHasPeople) return "admin";
  return person?.role ?? "viewer";
}

// ───────────────────────────── tasks ─────────────────────────────

/** Only a PR in review can be approved. */
export function assertApprovable(t: TaskRecord): asserts t is TaskRecord & { pr: NonNullable<TaskRecord["pr"]> } {
  if (t.pr === null || (t.status !== "awaiting_review" && t.status !== "iterating"))
    fail({ code: "TASK_NOT_REVIEWABLE", taskId: t.id, status: t.status, message: `Task ${t.id} is ${t.status}; only a PR in review can be approved. Wait until the task's PR is awaiting review.` });
}

/** Where a new task's issue goes: the repo asked for, else the team's repo, else the factory's first repo. */
export function chooseRepo(input: { repo: string | null; team: string | null; person: string }, known: string[], teams: Team[]): RepoRef {
  const team = teams.find((t) => t.slug === input.team) ?? teams.find((t) => t.members.some((m) => m.login === input.person));
  const teamRepo = team?.repos.find((r) => known.includes(r));
  const repo = input.repo ?? teamRepo ?? known[0] ?? null;
  if (repo === null || !known.includes(repo))
    fail({ code: "REPO_NOT_CONNECTED", repo, message: `The factory doesn't work in ${repo ?? "any repo"} yet. Connect it (connectRepo or FACTORY_REPOS) and ask again.` });
  const [owner = "", name = ""] = repo.split("/");
  return { host: "github", owner, name };
}

/** The issue that carries a new task: the ask's first line as title, and who asked, where. */
export function issueForAsk(
  input: { ask: string; person: string; origin: { label: string; url: string | null } | null; labels: string[] },
  factoryLabel: string,
  mention: (login: string) => string,
): { title: string; body: string; labels: string[] } {
  const title = (input.ask.split("\n")[0] ?? "").trim().slice(0, 120) || "Task from the factory app";
  const where = input.origin ? (input.origin.url ? `[${input.origin.label}](${input.origin.url})` : input.origin.label) : "the factory app";
  return {
    title,
    body: `${input.ask}\n\n_Asked by ${mention(input.person)} in ${where}._`,
    labels: [factoryLabel, ...input.labels.filter((l) => l !== factoryLabel)],
  };
}

/** How the factory names a person on the code host. Simulated orgs use made-up logins that a real user may own. */
export function mentionFor(mentions: boolean): (login: string) => string {
  return (login) => (mentions ? `@${login}` : `\`${login}\``);
}

// ───────────────────────────── factories ─────────────────────────────

/** A rollout change: a share needs a candidate, and no candidate means no share. */
export function rolloutChange(factory: string, input: { live: string | null; candidate: string | null; share: number; note: string | null }, by: string): Omit<RolloutState, "updatedAt"> {
  if (input.candidate === null && input.share > 0) fail(errors.invalid("A share needs a candidate version. Name the candidate, or set the share to 0.", [{ path: "share", message: "needs a candidate" }]));
  return { factory, live: input.live, candidate: input.candidate, share: input.candidate === null ? 0 : input.share, updatedBy: by, note: input.note };
}

// ───────────────────────────── org ─────────────────────────────

/** Teams made in the app, as the directory's Team shape. */
export const asTeam = (t: OrgTeam): Team => ({
  slug: t.slug,
  name: t.name,
  source: "app",
  members: t.members.map((m) => ({ login: m.login, name: null, role: m.role })),
  repos: t.repos,
  factory: t.factory,
});

/** Config teams win on a slug clash: factory.yaml is the reviewed source. */
export function mergeTeams(directory: Team[], app: OrgTeam[]): Team[] {
  // The inferred "everyone" team is only a stand-in for an org with no teams; once teams exist it would
  // claim every person first and send all their work to the default factory.
  const config = app.length ? directory.filter((t) => t.source !== "inferred") : directory;
  const seen = new Set(config.map((t) => t.slug));
  return [...config, ...app.filter((t) => !seen.has(t.slug)).map(asTeam)];
}

/** Setup progress, computed from what exists (never stored). */
export function setupSteps(s: Omit<OrgState, "setup" | "replies">, taskCount: number): SetupStep[] {
  const joined = s.people.filter((p) => p.status === "joined").length;
  const askSources = s.sources.filter((x) => x.uses.includes("asks"));
  const outcomeSources = s.sources.filter((x) => x.uses.includes("outcomes") || x.uses.includes("deploys"));
  const teamFactories = s.teams.filter((t) => t.factory !== "default").length;
  return [
    { key: "org", title: "Name your org", done: s.org !== null, detail: s.org ? s.org.name : "Give the factory your org's name.", href: "/setup#org" },
    { key: "repo", title: "Connect a repo", done: s.repos.length > 0, detail: s.repos.length ? s.repos.map((r) => r.repo).join(", ") : "The factory opens PRs here.", href: "/setup#repo" },
    {
      key: "sources",
      title: "Connect where work comes from and where outcomes land",
      done: askSources.length > 0 && outcomeSources.length > 0,
      detail: s.sources.length ? `${askSources.length} for asks, ${outcomeSources.length} for deploys and incidents` : "Slack, Microsoft Teams or Jira for asks; Datadog, Rootly or your CD tool for what happens after merge.",
      href: "/setup#sources",
    },
    { key: "teams", title: "Create teams", done: s.teams.length > 0, detail: s.teams.length ? s.teams.map((t) => t.name).join(", ") : "Each team gets its own scope, factory and numbers.", href: "/setup#teams" },
    { key: "factories", title: "Give teams their factory", done: s.teams.length > 0 && (teamFactories > 0 || s.factories.length === 0), detail: teamFactories ? `${teamFactories} team${teamFactories === 1 ? "" : "s"} on a team factory` : "Teams start on the org default; a team factory adds its own scorers, benchmarks, world and merge rules.", href: "/setup#factories" },
    { key: "people", title: "Invite people", done: s.people.length > 1, detail: s.people.length ? `${s.people.length} invited, ${joined} joined` : "Engineers, managers, directors, the factory and platform owners, and the VP.", href: "/setup#people" },
    { key: "first_task", title: "Run a first task", done: taskCount > 0, detail: taskCount ? `${taskCount} task${taskCount === 1 ? "" : "s"} so far` : "Ask in Slack, Teams, Jira or the app.", href: "/tasks/new" },
  ];
}
