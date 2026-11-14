/**
 * The org as the app sets it up: who the org is, the people invited and their personas, the teams and
 * factories made in the app, the repos connected, and the signal sources connected (Slack, Microsoft
 * Teams, Jira, Datadog, Rootly, any CDEvents producer). factory.yaml can still define teams and
 * factories; the app adds to them, it never hides them.
 *
 * Inbound events arrive as CloudEvents 1.0 (one envelope for every tool); a translator per source turns
 * each into an ask, a signal, an outcome or nothing, and the result is kept beside the raw event.
 */
import { z } from "zod";

/** The six people the app is designed for. A persona picks a person's home page; it never limits access. */
export const Persona = z.enum(["engineer", "em", "director", "factory_engineer", "platform_director", "vp"]);
export type Persona = z.infer<typeof Persona>;

export const PERSONA_LABEL: Record<Persona, string> = {
  engineer: "Engineer",
  em: "Engineering manager",
  director: "Engineering director",
  factory_engineer: "Factory engineer",
  platform_director: "Director of platforms",
  vp: "VP / CTO",
};

/** App role (see the dashboard's auth): viewers read, engineers work tasks, admins change factories and spend. */
export const OrgRole = z.enum(["viewer", "engineer", "admin"]);
export type OrgRole = z.infer<typeof OrgRole>;

/** The role a persona gets unless the inviter picks another. */
export const DEFAULT_ROLE: Record<Persona, OrgRole> = {
  engineer: "engineer",
  em: "engineer",
  director: "viewer",
  factory_engineer: "admin",
  platform_director: "admin",
  vp: "viewer",
};

/** The same person in each connected tool, so a Slack mention or a Jira reporter maps to one login. */
export const Identities = z.object({
  github: z.string().optional(),
  slack: z.string().optional(), // Slack user id, e.g. U024BE7LH
  msteams: z.string().optional(), // Entra (AAD) object id
  jira: z.string().optional(), // Atlassian accountId
});
export type Identities = z.infer<typeof Identities>;

export const Person = z.object({
  login: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
  name: z.string().max(120).nullable(),
  email: z.string().email().nullable(),
  persona: Persona,
  role: OrgRole,
  identities: Identities.default({}),
  status: z.enum(["invited", "joined"]),
  invitedBy: z.string().nullable(),
  invitedAt: z.string(),
  joinedAt: z.string().nullable(),
});
export type Person = z.infer<typeof Person>;

/** A team made in the app. `scope` says which part of a shared repo the team owns (paths, labels). */
export const OrgTeam = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  name: z.string().min(1).max(80),
  description: z.string().max(500).nullable().default(null),
  members: z.array(z.object({ login: z.string(), role: z.enum(["member", "maintainer"]).default("member") })).default([]),
  repos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).default([]),
  factory: z.string().default("default"),
  scope: z.object({ paths: z.array(z.string()).default([]), labels: z.array(z.string()).default([]) }).default({ paths: [], labels: [] }),
  createdBy: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type OrgTeam = z.infer<typeof OrgTeam>;

/** A team factory made in the app: what it changes on top of the org default (same shape as factory.yaml). */
export const OrgFactory = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  extends: z.string().default("default"),
  description: z.string().max(500).nullable().default(null),
  scorers: z.array(z.string()).default([]),
  benchmarks: z.array(z.string()).default([]),
  world: z.string().nullable().default(null),
  mergeRisk: z.object({ high: z.array(z.string()).default([]), low: z.array(z.string()).default([]) }).nullable().default(null),
  createdBy: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type OrgFactory = z.infer<typeof OrgFactory>;

export const SourceKind = z.enum(["github", "slack", "msteams", "jira", "datadog", "rootly", "pagerduty", "dx", "cdevents"]);
export type SourceKind = z.infer<typeof SourceKind>;

export const SOURCE_LABEL: Record<SourceKind, string> = {
  github: "GitHub",
  slack: "Slack",
  msteams: "Microsoft Teams",
  jira: "Jira",
  datadog: "Datadog",
  rootly: "Rootly",
  pagerduty: "PagerDuty",
  dx: "DX",
  cdevents: "CDEvents (any CI/CD tool)",
};

/**
 * A connected tool. Its events arrive at POST /v1/events as CloudEvents whose `source` starts with
 * `ceSource`. `routes` maps a channel, project or service to a team, so an ask lands in the right team.
 */
export const ConnectedSource = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  kind: SourceKind,
  name: z.string().min(1).max(80),
  ceSource: z.string().min(1).max(300),
  uses: z.array(z.enum(["asks", "outcomes", "deploys"])).min(1),
  routes: z.record(z.string(), z.string()).default({}),
  /**
   * How the factory answers people in the thread an ask came from. "post": with the tool's own API, using the
   * credentials named by `tokenEnv` (Slack bot token; Teams "APP_ID:PASSWORD"; Jira "email:api-token").
   * "cloudevents": POST a dev.openfactory.task.updated CloudEvent to `url` for the org to route on.
   * "record": keep the reply in the app only (no credentials yet, or a simulated org).
   */
  reply: z
    .object({ mode: z.enum(["post", "cloudevents", "record"]), tokenEnv: z.string().nullable().default(null), url: z.string().nullable().default(null), apiBase: z.string().nullable().default(null) })
    .default({ mode: "record", tokenEnv: null, url: null, apiBase: null }),
  connectedBy: z.string().nullable(),
  connectedAt: z.string(),
});
export type ConnectedSource = z.infer<typeof ConnectedSource>;

/** Where to answer an ask: the chat thread or ticket it came from, and the task it became. */
export const ReplyThread = z.object({
  key: z.string(),
  sourceId: z.string(),
  kind: SourceKind,
  place: z.string().nullable(),
  /** Slack message ts, Teams activity id, Jira issue key. */
  thread: z.string().nullable(),
  /** Teams only: conversation id and the Bot Framework service URL to reply through. */
  conversation: z.string().nullable().default(null),
  serviceUrl: z.string().nullable().default(null),
  repo: z.string(),
  issueNumber: z.number().int(),
  /** The last task status the thread was told about. */
  told: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type ReplyThread = z.infer<typeof ReplyThread>;

export const SentReply = z.object({
  key: z.string(),
  sourceId: z.string(),
  threadKey: z.string(),
  taskId: z.string(),
  status: z.string(),
  text: z.string(),
  at: z.string(),
  /** sent: delivered by the tool's API or the CloudEvents endpoint; recorded: kept in the app only; failed: see detail. */
  delivery: z.enum(["sent", "recorded", "failed"]),
  detail: z.string().nullable(),
});
export type SentReply = z.infer<typeof SentReply>;

export const ConnectedRepo = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  connectedBy: z.string().nullable(),
  connectedAt: z.string(),
});
export type ConnectedRepo = z.infer<typeof ConnectedRepo>;

export const OrgInfo = z.object({
  name: z.string().min(1).max(80),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  /** True when this org is a simulation (fake people and sources); the app says so on every page. */
  simulated: z.boolean().default(false),
});
export type OrgInfo = z.infer<typeof OrgInfo>;

/** One step of setup, computed from the org's state (never stored), so it can't drift from reality. */
export const SetupStep = z.object({
  key: z.enum(["org", "repo", "sources", "teams", "factories", "people", "first_task"]),
  title: z.string(),
  done: z.boolean(),
  detail: z.string(),
  href: z.string(),
});
export type SetupStep = z.infer<typeof SetupStep>;

export const OrgState = z.object({
  org: OrgInfo.nullable(),
  repos: z.array(ConnectedRepo),
  people: z.array(Person),
  teams: z.array(OrgTeam),
  factories: z.array(OrgFactory),
  sources: z.array(ConnectedSource),
  setup: z.array(SetupStep),
  /** The latest replies to the threads and tickets asks came from, newest first. */
  replies: z.array(SentReply).default([]),
});
export type OrgState = z.infer<typeof OrgState>;

// ───────────────────────────── inbound events (CloudEvents 1.0) ─────────────────────────────

/** A CloudEvents 1.0 event in structured JSON form. Extension attributes pass through. */
export const CloudEvent = z
  .object({
    specversion: z.literal("1.0"),
    id: z.string().min(1).max(200),
    source: z.string().min(1).max(500),
    type: z.string().min(1).max(200),
    time: z.string().optional(),
    subject: z.string().max(500).optional(),
    datacontenttype: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();
export type CloudEvent = z.infer<typeof CloudEvent>;

/** What the factory did with one inbound event. */
export const IntakeResult = z.object({
  kind: z.enum(["ask", "signal", "outcome", "ignored", "error"]),
  detail: z.string(),
  taskId: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
});
export type IntakeResult = z.infer<typeof IntakeResult>;

export const InboundEvent = z.object({
  key: z.string(), // `${source}#${id}`: CloudEvents say source + id is unique
  sourceId: z.string().nullable(), // the ConnectedSource it matched, if any
  kind: SourceKind.nullable(),
  event: CloudEvent,
  receivedAt: z.string(),
  result: IntakeResult,
});
export type InboundEvent = z.infer<typeof InboundEvent>;
