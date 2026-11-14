/**
 * One translator per tool. Each reads the tool's own webhook payload (carried as the CloudEvent's `data`)
 * and says what it means for the factory: someone asks for work, a PR changed state, or something
 * happened after a merge. Vendor shapes stop here; the server only sees `Intake`.
 *
 * Payload shapes follow each vendor's documented webhook format (Slack Events API `event_callback`,
 * Bot Framework Activity for Microsoft Teams, Jira Cloud webhooks, Datadog webhook integration
 * defaults, Rootly and PagerDuty v3 webhooks) and CDEvents 0.5 for any CI/CD or incident tool.
 */
import type { CloudEvent, ConnectedSource, Outcome, SourceKind } from "@openfactory/contracts";

/** Who in a tool did it. The server maps it to a person by identity, then by email. */
export type Actor = { kind: SourceKind; id: string | null; email: string | null; name: string | null };

/** Which task an outcome belongs to. Any one field can match. */
export type TaskMatch = { taskId?: string; repo?: string; prNumber?: number; sha?: string };

export type Intake =
  | {
      kind: "ask";
      ask: string;
      actor: Actor;
      /** The channel, project or service the ask came from: the source's `routes` map it to a team. */
      place: string | null;
      origin: { label: string; url: string | null };
      labels: string[];
      /** Where to answer: Slack ts, Teams activity (with conversation and service URL), Jira key. */
      reply: { thread: string | null; conversation: string | null; serviceUrl: string | null };
    }
  | { kind: "merge"; repo: string; prNumber: number; at: string }
  | { kind: "close"; repo: string; prNumber: number; at: string }
  | { kind: "outcome"; match: TaskMatch; outcome: Pick<Outcome, "kind" | "detail" | "at">; ref: string }
  | { kind: "ignore"; reason: string };

export type TranslateContext = {
  /** The label that means "the factory should do this" (Jira labels, Datadog tags). */
  factoryLabel: string;
  /** The connected source the event came from, if any. */
  source: ConnectedSource | null;
  now: string;
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const SHA = /\b[0-9a-f]{40}\b/;

/** The kind of tool an event comes from: the connected source's kind, else the event type's namespace. */
export function kindOf(ev: CloudEvent, source: ConnectedSource | null): SourceKind | null {
  if (source) return source.kind;
  const t = ev.type;
  if (t.startsWith("dev.cdevents.") || t.startsWith("dev.cdeventsx.")) return "cdevents";
  if (t.startsWith("com.slack.")) return "slack";
  if (t.startsWith("com.microsoft.teams.")) return "msteams";
  if (t.startsWith("com.atlassian.jira.")) return "jira";
  if (t.startsWith("com.datadoghq.")) return "datadog";
  if (t.startsWith("com.rootly.")) return "rootly";
  if (t.startsWith("com.pagerduty.")) return "pagerduty";
  return null;
}

export function translate(ev: CloudEvent, ctx: TranslateContext): Intake {
  // CDEvents can come from any tool (Jira, Rootly, Argo...), so they're read by type, not by source.
  if (ev.type.startsWith("dev.cdevents.") || ev.type.startsWith("dev.cdeventsx.")) return cdevents(ev, ctx);
  switch (kindOf(ev, ctx.source)) {
    case "slack":
      return slack(ev);
    case "msteams":
      return msteams(ev);
    case "jira":
      return jira(ev, ctx);
    case "datadog":
      return datadog(ev, ctx);
    case "rootly":
      return rootly(ev, ctx);
    case "pagerduty":
      return pagerduty(ev, ctx);
    default:
      return { kind: "ignore", reason: `no translator for ${ev.type}` };
  }
}

// ── chat: Slack and Microsoft Teams ──

/** Slack Events API: an `event_callback` whose event is an `app_mention` ("@factory add a CSV export"). */
function slack(ev: CloudEvent): Intake {
  const d = obj(ev.data);
  const e = obj(d.event);
  if (e.type !== "app_mention" && e.type !== "message") return { kind: "ignore", reason: `Slack ${String(e.type ?? d.type)} is not an ask` };
  if (e.bot_id || e.subtype === "bot_message") return { kind: "ignore", reason: "messages from bots never start work" };
  const text = (str(e.text) ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
  if (text.length < 3) return { kind: "ignore", reason: "empty mention" };
  const channel = str(e.channel);
  const ts = str(e.thread_ts) ?? str(e.ts);
  const base = ev.source.startsWith("https://") ? ev.source.replace(/\/$/, "") : null;
  return {
    kind: "ask",
    ask: text,
    actor: { kind: "slack", id: str(e.user), email: null, name: null },
    place: channel,
    origin: { label: `Slack ${channel ? `#${str(e.channel_name) ?? channel}` : ""}`.trim(), url: base && channel && ts ? `${base}/archives/${channel}/p${ts.replace(".", "")}` : null },
    labels: [],
    reply: { thread: ts, conversation: null, serviceUrl: null },
  };
}

/** Microsoft Teams (Bot Framework Activity): a channel message that @mentions the factory bot. */
function msteams(ev: CloudEvent): Intake {
  const a = obj(ev.data);
  if (a.type !== "message") return { kind: "ignore", reason: `Teams activity ${String(a.type)} is not an ask` };
  const from = obj(a.from);
  const text = (str(a.text) ?? "").replace(/<at>[^<]*<\/at>/g, "").replace(/<[^>]+>/g, "").trim();
  if (text.length < 3) return { kind: "ignore", reason: "empty mention" };
  const cd = obj(a.channelData);
  const channel = obj(cd.channel);
  return {
    kind: "ask",
    ask: text,
    actor: { kind: "msteams", id: str(from.aadObjectId), email: null, name: str(from.name) },
    place: str(channel.id),
    origin: { label: `Microsoft Teams ${str(channel.name) ? `#${str(channel.name)}` : ""}`.trim(), url: null },
    labels: [],
    reply: { thread: str(a.id), conversation: str(obj(a.conversation).id), serviceUrl: str(a.serviceUrl) },
  };
}

// ── work trackers: Jira ──

/** Jira Cloud webhook: an issue created, or updated to carry the factory label. */
function jira(ev: CloudEvent, ctx: TranslateContext): Intake {
  const d = obj(ev.data);
  const webhookEvent = str(d.webhookEvent);
  if (webhookEvent !== "jira:issue_created" && webhookEvent !== "jira:issue_updated") return { kind: "ignore", reason: `Jira ${webhookEvent ?? ev.type} is not an ask` };
  const issue = obj(d.issue);
  const f = obj(issue.fields);
  const labels = Array.isArray(f.labels) ? f.labels.filter((l): l is string => typeof l === "string") : [];
  if (!labels.includes(ctx.factoryLabel)) return { kind: "ignore", reason: `no "${ctx.factoryLabel}" label` };
  if (webhookEvent === "jira:issue_updated") {
    const items = Array.isArray(obj(d.changelog).items) ? (obj(d.changelog).items as unknown[]).map(obj) : [];
    const added = items.some((i) => i.field === "labels" && String(i.toString ?? "").split(" ").includes(ctx.factoryLabel) && !String(i.fromString ?? "").split(" ").includes(ctx.factoryLabel));
    if (!added) return { kind: "ignore", reason: "the factory label was already on the issue" };
  }
  const key = str(issue.key) ?? "?";
  const self = str(issue.self);
  const site = self ? self.replace(/\/rest\/api\/.*$/, "") : null;
  const reporter = obj(f.reporter);
  const user = obj(d.user);
  const project = str(obj(f.project).key);
  const summary = str(f.summary) ?? key;
  const description = typeof f.description === "string" ? f.description : "";
  return {
    kind: "ask",
    ask: `${summary}\n\n${description}`.trim(),
    actor: { kind: "jira", id: str(reporter.accountId) ?? str(user.accountId), email: str(reporter.emailAddress) ?? str(user.emailAddress), name: str(reporter.displayName) },
    place: project,
    origin: { label: `Jira ${key}`, url: site ? `${site}/browse/${key}` : null },
    labels: labels.filter((l) => l !== ctx.factoryLabel),
    reply: { thread: key, conversation: null, serviceUrl: site },
  };
}

// ── incidents and alerts: Datadog, Rootly, PagerDuty ──

/** The task an alert or incident points at: a commit sha, a PR URL or a factory task id anywhere in its text or tags. */
function matchIn(texts: Array<string | null>): TaskMatch | null {
  const all = texts.filter((t): t is string => t !== null).join("\n");
  const task = /\btask_[a-z0-9]{6,}\b/.exec(all)?.[0];
  if (task) return { taskId: task };
  const pr = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(all);
  if (pr) return { repo: pr[1]!, prNumber: Number(pr[2]) };
  const sha = SHA.exec(all)?.[0];
  return sha ? { sha } : null;
}

/** Datadog webhook integration: a monitor that triggered, tagged with the deploy's git.commit.sha. */
function datadog(ev: CloudEvent, ctx: TranslateContext): Intake {
  const d = obj(ev.data);
  const transition = str(d.alert_transition) ?? "";
  if (!/^(Triggered|Re-Triggered)$/i.test(transition)) return { kind: "ignore", reason: `alert ${transition || "update"} is not a new problem` };
  const tags = typeof d.tags === "string" ? d.tags.split(",").map((s) => s.trim()) : Array.isArray(d.tags) ? d.tags.map(String) : [];
  const shaTag = tags.find((t) => t.startsWith("git.commit.sha:") || t.startsWith("version:"))?.split(":")[1] ?? null;
  const match = matchIn([shaTag, str(d.body), str(d.title)]);
  const title = str(d.title) ?? "Datadog alert";
  if (match) return { kind: "outcome", match, outcome: { kind: "incident_linked", detail: `Datadog: ${title}`, at: isoOr(d.date, ctx.now) }, ref: `datadog:${str(d.id) ?? ev.id}` };
  return { kind: "ignore", reason: "the alert names no commit, PR or task" };
}

/** Rootly webhook (`incident.created`): linked to a change by a sha, PR URL or task id in its summary or labels. */
function rootly(ev: CloudEvent, ctx: TranslateContext): Intake {
  const d = obj(ev.data);
  const e = obj(d.event);
  const inc = obj(d.data);
  const type = str(e.type) ?? ev.type.replace(/^com\.rootly\./, "");
  if (type !== "incident.created") return { kind: "ignore", reason: `Rootly ${type} is not a new incident` };
  const labels = Array.isArray(inc.labels) ? inc.labels.map((l) => JSON.stringify(l)) : [];
  const match = matchIn([str(inc.summary), str(inc.title), ...labels]);
  const sev = str(obj(inc.severity).name);
  if (!match) return { kind: "ignore", reason: "the incident names no commit, PR or task" };
  return {
    kind: "outcome",
    match,
    outcome: { kind: "incident_linked", detail: `Rootly${sev ? ` ${sev}` : ""}: ${str(inc.title) ?? "incident"}`, at: isoOr(inc.started_at ?? e.issued_at, ctx.now) },
    ref: `rootly:${str(inc.id) ?? ev.id}`,
  };
}

/** PagerDuty v3 webhook: `incident.triggered`, linked the same way. */
function pagerduty(ev: CloudEvent, ctx: TranslateContext): Intake {
  const e = obj(obj(ev.data).event);
  if (e.event_type !== "incident.triggered") return { kind: "ignore", reason: `PagerDuty ${String(e.event_type)} is not a new incident` };
  const inc = obj(e.data);
  const match = matchIn([str(inc.title), str(obj(inc.body).details as unknown)]);
  if (!match) return { kind: "ignore", reason: "the incident names no commit, PR or task" };
  return { kind: "outcome", match, outcome: { kind: "incident_linked", detail: `PagerDuty: ${str(inc.title) ?? "incident"}`, at: isoOr(e.occurred_at, ctx.now) }, ref: `pagerduty:${str(inc.id) ?? ev.id}` };
}

// ── CDEvents (any CI/CD, ticketing or incident tool) ──

/** `pkg:github/owner/name@<sha>` (or any purl/string with a 40-hex sha) → the sha. */
const shaOf = (artifactId: string | null) => (artifactId ? (SHA.exec(artifactId)?.[0] ?? null) : null);

/** A change id: "owner/name#12", ".../pull/12" or "12" with the repository in the content. */
function changeRef(subject: Record<string, unknown>): { repo: string; prNumber: number } | null {
  const id = str(subject.id) ?? "";
  const content = obj(subject.content);
  const repoFromContent = str(obj(content.repository).id);
  const m = /([\w.-]+\/[\w.-]+)(?:#|\/pull\/)(\d+)$/.exec(id);
  if (m) return { repo: m[1]!, prNumber: Number(m[2]) };
  if (/^\d+$/.test(id) && repoFromContent && /^[\w.-]+\/[\w.-]+$/.test(repoFromContent)) return { repo: repoFromContent, prNumber: Number(id) };
  return null;
}

function cdevents(ev: CloudEvent, ctx: TranslateContext): Intake {
  const d = obj(ev.data);
  const context = obj(d.context);
  const subject = obj(d.subject);
  const content = obj(subject.content);
  const at = isoOr(context.timestamp ?? ev.time, ctx.now);
  const type = ev.type.replace(/\.\d+\.\d+\.\d+(-[\w.]+)?$/, ""); // drop the event version
  const env = str(obj(content.environment).id);
  switch (type) {
    case "dev.cdevents.ticket.created": {
      const labels = Array.isArray(content.labels) ? content.labels.map(String) : [];
      if (!labels.includes(ctx.factoryLabel)) return { kind: "ignore", reason: `no "${ctx.factoryLabel}" label` };
      return {
        kind: "ask",
        ask: str(content.summary) ?? "Ticket",
        actor: { kind: "cdevents", id: str(content.creator), email: str(content.creator)?.includes("@") ? str(content.creator) : null, name: null },
        place: str(content.group),
        origin: { label: `Ticket ${str(subject.id) ?? ""}`.trim(), url: str(content.uri) },
        labels: labels.filter((l) => l !== ctx.factoryLabel),
        reply: { thread: str(subject.id), conversation: null, serviceUrl: null },
      };
    }
    case "dev.cdevents.change.merged": {
      const c = changeRef(subject);
      return c ? { kind: "merge", ...c, at } : { kind: "ignore", reason: "change.merged names no repo and PR" };
    }
    case "dev.cdevents.change.abandoned": {
      const c = changeRef(subject);
      return c ? { kind: "close", ...c, at } : { kind: "ignore", reason: "change.abandoned names no repo and PR" };
    }
    case "dev.cdevents.service.deployed":
    case "dev.cdevents.service.upgraded": {
      const sha = shaOf(str(content.artifactId));
      if (!sha) return { kind: "ignore", reason: "the deploy names no commit" };
      return { kind: "outcome", match: { sha }, outcome: { kind: "deployed", detail: `deployed to ${env ?? "an environment"}`, at }, ref: `deploy:${str(context.id) ?? ev.id}` };
    }
    case "dev.cdevents.service.rolledback": {
      const sha = shaOf(str(content.artifactId));
      if (!sha) return { kind: "ignore", reason: "the rollback names no commit" };
      return { kind: "outcome", match: { sha }, outcome: { kind: "reverted", detail: `rolled back in ${env ?? "an environment"}`, at }, ref: `rollback:${str(context.id) ?? ev.id}` };
    }
    case "dev.cdevents.incident.detected":
    case "dev.cdevents.incident.reported": {
      const match = (shaOf(str(content.artifactId)) ? { sha: shaOf(str(content.artifactId))! } : null) ?? matchIn([str(content.description), str(content.ticketURI)]);
      if (!match) return { kind: "ignore", reason: "the incident names no commit, PR or task" };
      return { kind: "outcome", match, outcome: { kind: "incident_linked", detail: `incident: ${str(content.description) ?? str(subject.id) ?? "detected"}`, at }, ref: `incident:${str(subject.id) ?? ev.id}` };
    }
    // Custom events (CDEvents `dev.cdeventsx.<tool>-<subject>.<predicate>`): a revert or a follow-up fix of a change.
    case "dev.cdeventsx.openfactory-change.reverted":
    case "dev.cdeventsx.openfactory-change.fixed": {
      const c = changeRef(subject);
      const match: TaskMatch | null = c ?? matchIn([str(content.of), str(content.description)]);
      if (!match) return { kind: "ignore", reason: "names no change" };
      const kind = type.endsWith("reverted") ? ("reverted" as const) : ("hotfix" as const);
      return { kind: "outcome", match, outcome: { kind, detail: str(content.description) ?? (kind === "reverted" ? "reverted" : "follow-up fix"), at }, ref: `${kind}:${str(context.id) ?? ev.id}` };
    }
    default:
      return { kind: "ignore", reason: `${ev.type} isn't used by the factory` };
  }
}

function isoOr(v: unknown, fallback: string): string {
  if (typeof v === "number") return new Date(v > 1e12 ? v : v * 1000).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return fallback;
}
