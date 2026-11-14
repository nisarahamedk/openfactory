/**
 * Faithful fakes of each tool's webhook, wrapped as CloudEvents: what a simulated org (or a test) sends to
 * POST /v1/events. Each builder fills the fields the real tool sends that the translators read, plus the
 * usual surrounding ones, so a fake event looks like the real thing in the app's event log.
 */
import { randomBytes } from "node:crypto";
import type { CloudEvent } from "@openfactory/contracts";

const rid = (n = 8) => randomBytes(n).toString("hex");
const ce = (source: string, type: string, data: unknown, opts: { id?: string; time?: string; subject?: string } = {}): CloudEvent => ({
  specversion: "1.0",
  id: opts.id ?? rid(),
  source,
  type,
  time: opts.time ?? new Date().toISOString(),
  ...(opts.subject ? { subject: opts.subject } : {}),
  datacontenttype: "application/json",
  data,
});

/** Slack Events API `event_callback` with an `app_mention`. `source` is the workspace URL, e.g. https://acme.slack.com. */
export function slackMention(i: { source: string; teamId?: string; user: string; channel: string; channelName?: string; text: string; botUser?: string; time?: string }): CloudEvent {
  const ts = `${Math.floor(Date.parse(i.time ?? new Date().toISOString()) / 1000)}.${rid(3)}`;
  const eventId = `Ev${rid(5).toUpperCase()}`;
  return ce(
    i.source,
    "com.slack.events.app_mention",
    {
      token: "fake",
      team_id: i.teamId ?? "T0ACME",
      api_app_id: "A0FACTORY",
      type: "event_callback",
      event_id: eventId,
      event_time: Math.floor(Date.parse(i.time ?? new Date().toISOString()) / 1000),
      event: { type: "app_mention", user: i.user, text: `<@${i.botUser ?? "U0FACTORY"}> ${i.text}`, ts, channel: i.channel, channel_name: i.channelName, event_ts: ts },
    },
    { id: eventId, ...(i.time ? { time: i.time } : {}), subject: i.channel },
  );
}

/** Bot Framework Activity: a Microsoft Teams channel message that @mentions the factory. */
export function teamsMessage(i: { source: string; aadObjectId: string; name: string; channelId: string; channelName: string; text: string; time?: string }): CloudEvent {
  const id = `${Date.now()}${rid(2)}`;
  return ce(
    i.source,
    "com.microsoft.teams.activity.message",
    {
      type: "message",
      id,
      timestamp: i.time ?? new Date().toISOString(),
      serviceUrl: "https://smba.trafficmanager.net/emea/",
      channelId: "msteams",
      from: { id: `29:${rid(6)}`, name: i.name, aadObjectId: i.aadObjectId },
      conversation: { id: `${i.channelId};messageid=${id}`, conversationType: "channel", isGroup: true },
      recipient: { id: "28:factory-bot", name: "Factory" },
      text: `<at>Factory</at> ${i.text}`,
      entities: [{ type: "mention", text: "<at>Factory</at>", mentioned: { id: "28:factory-bot", name: "Factory" } }],
      channelData: { tenant: { id: "acme-tenant" }, team: { id: "19:acme-team" }, channel: { id: i.channelId, name: i.channelName } },
    },
    { id, ...(i.time ? { time: i.time } : {}) },
  );
}

/** Jira Cloud `jira:issue_created` webhook. `source` is the site URL, e.g. https://acme.atlassian.net. */
export function jiraIssueCreated(i: { source: string; key: string; project: string; summary: string; description?: string; labels: string[]; reporter: { accountId: string; email: string; name: string }; time?: string }): CloudEvent {
  const id = String(10000 + Math.floor(Math.random() * 90000));
  const ts = Date.parse(i.time ?? new Date().toISOString());
  return ce(
    i.source,
    "com.atlassian.jira.issue_created",
    {
      timestamp: ts,
      webhookEvent: "jira:issue_created",
      issue_event_type_name: "issue_created",
      user: { accountId: i.reporter.accountId, emailAddress: i.reporter.email, displayName: i.reporter.name },
      issue: {
        id,
        key: i.key,
        self: `${i.source.replace(/\/$/, "")}/rest/api/2/issue/${id}`,
        fields: {
          summary: i.summary,
          description: i.description ?? "",
          labels: i.labels,
          issuetype: { name: "Task" },
          project: { key: i.project },
          reporter: { accountId: i.reporter.accountId, emailAddress: i.reporter.email, displayName: i.reporter.name },
          created: new Date(ts).toISOString(),
        },
      },
    },
    { id: `${i.key}-created`, ...(i.time ? { time: i.time } : {}), subject: i.key },
  );
}

/** Datadog webhook integration payload (default template fields) for a monitor that triggered on a deploy. */
export function datadogAlert(i: { source?: string; title: string; body?: string; sha?: string; service: string; transition?: "Triggered" | "Recovered"; time?: string }): CloudEvent {
  const id = String(Math.floor(Math.random() * 1e12));
  return ce(
    i.source ?? "https://app.datadoghq.com",
    "com.datadoghq.monitor.alert",
    {
      id,
      title: `[${i.transition ?? "Triggered"}] ${i.title}`,
      body: i.body ?? "",
      last_updated: Date.parse(i.time ?? new Date().toISOString()),
      event_type: "query_alert_monitor",
      date: Date.parse(i.time ?? new Date().toISOString()),
      org: { id: "acme", name: "Acme" },
      alert_transition: i.transition ?? "Triggered",
      alert_type: "error",
      tags: [`service:${i.service}`, "env:prod", ...(i.sha ? [`git.commit.sha:${i.sha}`] : [])].join(","),
      link: `https://app.datadoghq.com/event/event?id=${id}`,
    },
    { ...(i.time ? { time: i.time } : {}) },
  );
}

/** Rootly `incident.created` webhook. Link it to a change by putting the sha or PR URL in the summary. */
export function rootlyIncident(i: { source?: string; title: string; summary: string; severity: "SEV0" | "SEV1" | "SEV2" | "SEV3"; time?: string }): CloudEvent {
  const id = rid(8);
  const at = i.time ?? new Date().toISOString();
  return ce(
    i.source ?? "https://rootly.com/acme",
    "com.rootly.incident.created",
    { event: { id: rid(8), type: "incident.created", issued_at: at }, data: { id, title: i.title, summary: i.summary, severity: { name: i.severity }, started_at: at, url: `https://rootly.com/account/incidents/${id}`, status: "started" } },
    { ...(i.time ? { time: i.time } : {}) },
  );
}

/** PagerDuty v3 webhook `incident.triggered`. */
export function pagerdutyIncident(i: { source?: string; title: string; time?: string }): CloudEvent {
  const id = `Q${rid(6).toUpperCase()}`;
  return ce(i.source ?? "https://acme.pagerduty.com", "com.pagerduty.incident.triggered", {
    event: { id: rid(8), event_type: "incident.triggered", resource_type: "incident", occurred_at: i.time ?? new Date().toISOString(), data: { id, type: "incident", title: i.title, html_url: `https://acme.pagerduty.com/incidents/${id}` } },
  });
}

// ── CDEvents 0.5 (event versions as released in spec v0.5.x) ──

const cd = (source: string, type: string, subject: { id: string; source?: string; content: Record<string, unknown> }, time?: string): CloudEvent => {
  const id = rid(10);
  const timestamp = time ?? new Date().toISOString();
  return ce(source, type, { context: { specversion: "0.5.0", id, source, type, timestamp }, subject: { ...subject, source: subject.source ?? source } }, { id, time: timestamp, subject: subject.id });
};

/** A change merged (CDEvents `change.merged`). The id is "owner/name#number". */
export const changeMerged = (i: { source: string; repo: string; prNumber: number; time?: string }) =>
  cd(i.source, "dev.cdevents.change.merged.0.3.0", { id: `${i.repo}#${i.prNumber}`, content: { repository: { id: i.repo, source: `https://github.com/${i.repo}` } } }, i.time);

export const changeAbandoned = (i: { source: string; repo: string; prNumber: number; time?: string }) =>
  cd(i.source, "dev.cdevents.change.abandoned.0.3.0", { id: `${i.repo}#${i.prNumber}`, content: { repository: { id: i.repo, source: `https://github.com/${i.repo}` } } }, i.time);

/** A service deployed (CDEvents `service.deployed`), artifact = the commit. */
export const serviceDeployed = (i: { source: string; service: string; environment: string; repo: string; sha: string; time?: string }) =>
  cd(i.source, "dev.cdevents.service.deployed.0.3.0", { id: i.service, content: { environment: { id: i.environment }, artifactId: `pkg:github/${i.repo}@${i.sha}` } }, i.time);

export const serviceRolledBack = (i: { source: string; service: string; environment: string; repo: string; sha: string; time?: string }) =>
  cd(i.source, "dev.cdevents.service.rolledback.0.3.0", { id: i.service, content: { environment: { id: i.environment }, artifactId: `pkg:github/${i.repo}@${i.sha}` } }, i.time);

/** An incident detected (CDEvents `incident.detected`), tied to the deployed commit. */
export const incidentDetected = (i: { source: string; id: string; description: string; environment: string; service: string; repo: string; sha: string; time?: string }) =>
  cd(i.source, "dev.cdevents.incident.detected.0.3.0", { id: i.id, content: { description: i.description, environment: { id: i.environment }, service: { id: i.service }, artifactId: `pkg:github/${i.repo}@${i.sha}` } }, i.time);

/** A ticket created (CDEvents `ticket.created`), e.g. from a tracker that speaks CDEvents. */
export const ticketCreated = (i: { source: string; id: string; summary: string; creator: string; labels: string[]; group?: string; uri: string; time?: string }) =>
  cd(i.source, "dev.cdevents.ticket.created.0.2.0", { id: i.id, content: { summary: i.summary, creator: i.creator, labels: i.labels, ...(i.group ? { group: i.group } : {}), uri: i.uri } }, i.time);

/** Custom CDEvents (`dev.cdeventsx`): a change reverted, or fixed by a follow-up change. */
export const changeReverted = (i: { source: string; repo: string; prNumber: number; description: string; time?: string }) =>
  cd(i.source, "dev.cdeventsx.openfactory-change.reverted.0.1.0", { id: `${i.repo}#${i.prNumber}`, content: { description: i.description } }, i.time);

export const changeFixed = (i: { source: string; repo: string; prNumber: number; description: string; time?: string }) =>
  cd(i.source, "dev.cdeventsx.openfactory-change.fixed.0.1.0", { id: `${i.repo}#${i.prNumber}`, content: { description: i.description } }, i.time);
