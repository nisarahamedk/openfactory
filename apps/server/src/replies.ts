/**
 * Answer people where they asked. An ask from Slack, Teams or Jira keeps a thread record; as its task moves
 * (picked up, ready for review, merged, failed) the factory replies in that thread. Each connected source
 * says how (`reply.mode`): with the tool's own API, as a CloudEvent the org routes itself, or recorded in
 * the app only. Every reply is kept, so the Sources page shows what people were told and whether it arrived.
 */
import type { ConnectedSource, ReplyThread, RepoRef, SentReply, TaskRecord } from "@openfactory/contracts";
import type { Ledger, OrgStore } from "@openfactory/ledger";

/** The statuses worth a message in the asker's thread, in order. */
const TELL = ["working", "awaiting_review", "merged", "closed", "failed"] as const;
type Told = (typeof TELL)[number];

const usd = (n: number) => `$${n.toFixed(2)}`;

/** What to say for a status, or null when there's nothing new to say. */
export function replyText(t: TaskRecord, status: Told, appUrl: string | null): string {
  const link = appUrl ? `${appUrl.replace(/\/$/, "")}/tasks/${t.id}` : null;
  const pr = t.pr ? `PR #${t.pr.number} (${t.pr.url})` : "the PR";
  switch (status) {
    case "working":
      return `On it: "${t.title}". I'll reply here when there's a PR to review.${link ? ` Follow along: ${link}` : ""}`;
    case "awaiting_review": {
      const shots = t.evidence.filter((e) => e.kind === "screenshot" || e.kind === "video").length;
      const tests = t.evidence.filter((e) => e.kind === "test-output").length;
      const proof = [shots ? `${shots} screenshot${shots === 1 ? "" : "s"}` : null, tests ? `${tests} test run${tests === 1 ? "" : "s"}` : null].filter(Boolean).join(" and ");
      return `Ready for review: ${pr}${proof ? `, with ${proof}` : ""}. Merge risk ${t.risk?.level ?? "not assessed"}; ${usd(t.usage.costUsd)} so far.${link ? ` ${link}` : ""}`;
    }
    case "merged":
      return `Merged: ${pr}. I'll keep watching it for reverts and incidents.`;
    case "closed":
      return `Closed without merging: ${pr}.`;
    case "failed":
      return `I couldn't finish "${t.title}".${link ? ` What happened, and a Retry button: ${link}` : " Reply here to have me try again."}`;
  }
}

type Fetch = typeof fetch;

/** Post one reply with the tool's own API. Throws with the tool's error on failure. */
async function post(f: Fetch, source: ConnectedSource, th: ReplyThread, text: string, env: Record<string, string | undefined>): Promise<string> {
  const cred = source.reply.tokenEnv ? env[source.reply.tokenEnv] : undefined;
  if (!cred) throw new Error(`no credentials: set ${source.reply.tokenEnv ?? "reply.tokenEnv"} on the factory server`);
  if (th.kind === "slack") {
    const r = await f("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${cred}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: th.place, thread_ts: th.thread, text }),
    });
    const b = (await r.json()) as { ok: boolean; error?: string; ts?: string };
    if (!b.ok) throw new Error(`Slack: ${b.error ?? r.status}`);
    return `Slack ts ${b.ts}`;
  }
  if (th.kind === "msteams") {
    const [appId, password] = cred.split(":");
    if (!th.serviceUrl || !th.conversation) throw new Error("Teams: the ask carried no conversation to reply to");
    const tok = await f("https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: appId ?? "", client_secret: password ?? "", scope: "https://api.botframework.com/.default" }),
    });
    if (!tok.ok) throw new Error(`Teams token: ${tok.status}`);
    const { access_token } = (await tok.json()) as { access_token: string };
    const path = `/v3/conversations/${encodeURIComponent(th.conversation)}/activities${th.thread ? `/${encodeURIComponent(th.thread)}` : ""}`;
    const r = await f(new URL(path, th.serviceUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "message", text, replyToId: th.thread }),
    });
    if (!r.ok) throw new Error(`Teams: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return "Teams reply posted";
  }
  if (th.kind === "jira") {
    const base = source.reply.apiBase ?? th.serviceUrl;
    if (!base || !th.thread) throw new Error("Jira: no site or issue key");
    const r = await f(`${base.replace(/\/$/, "")}/rest/api/3/issue/${encodeURIComponent(th.thread)}/comment`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(cred).toString("base64")}`, "content-type": "application/json" },
      body: JSON.stringify({ body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] } }),
    });
    if (!r.ok) throw new Error(`Jira: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return `Jira comment on ${th.thread}`;
  }
  throw new Error(`${th.kind} has no reply API; use reply mode "cloudevents" or "record"`);
}

/** The open-protocol path: a CloudEvent the org's own router (Knative, Argo Events, a webhook) forwards. */
async function cloudevent(f: Fetch, source: ConnectedSource, th: ReplyThread, t: TaskRecord, status: string, text: string, now: string, ceSource: string): Promise<string> {
  if (!source.reply.url) throw new Error("reply mode cloudevents needs a url");
  const r = await f(source.reply.url, {
    method: "POST",
    headers: { "content-type": "application/cloudevents+json" },
    body: JSON.stringify({
      specversion: "1.0",
      type: "dev.openfactory.task.updated.v1",
      source: ceSource,
      id: `${t.id}:${status}`,
      time: now,
      subject: t.id,
      datacontenttype: "application/json",
      data: { taskId: t.id, status, text, prUrl: t.pr?.url ?? null, reply: { sourceId: th.sourceId, kind: th.kind, place: th.place, thread: th.thread, conversation: th.conversation } },
    }),
  });
  if (!r.ok) throw new Error(`CloudEvents endpoint answered ${r.status}`);
  return `CloudEvent sent to ${new URL(source.reply.url).host}`;
}

export type ReplyDeps = {
  store: OrgStore;
  ledger: Pick<Ledger, "findByIssue">;
  appUrl: string | null;
  ceSource: string;
  now: () => string;
  log: (m: string, f?: object) => void;
  fetch?: Fetch;
  env?: Record<string, string | undefined>;
};

const repoOf = (s: string): RepoRef => {
  const [owner = "", name = ""] = s.split("/");
  return { host: "github", owner, name };
};

/** One pass: tell every open thread about its task's newest status it hasn't heard yet. Returns replies made. */
export async function tellThreads(d: ReplyDeps): Promise<SentReply[]> {
  const f = d.fetch ?? fetch;
  const sources = new Map((await d.store.sources()).map((s) => [s.id, s]));
  const out: SentReply[] = [];
  for (const th of await d.store.threads()) {
    if (th.told === "merged" || th.told === "closed") continue;
    const t = await d.ledger.findByIssue(repoOf(th.repo), th.issueNumber);
    if (!t) continue;
    // "On it" is said once, as soon as the task is picked up; after that only review, merge, close and failure are news.
    const listed = (TELL as readonly string[]).includes(t.status) ? (t.status as Told) : null;
    const next: Told | null = listed === "working" || listed === null ? (th.told === null && t.status !== "received" ? "working" : null) : listed;
    if (next === null || next === th.told) continue;
    const source = sources.get(th.sourceId);
    const text = replyText(t, next, d.appUrl);
    const at = d.now();
    let delivery: SentReply["delivery"] = "recorded";
    let detail: string | null = null;
    try {
      if (source?.reply.mode === "post") {
        detail = await post(f, source, th, text, d.env ?? process.env);
        delivery = "sent";
      } else if (source?.reply.mode === "cloudevents") {
        detail = await cloudevent(f, source, th, t, next, text, at, d.ceSource);
        delivery = "sent";
      } else detail = source ? "kept in the app (reply mode: record)" : "the source was disconnected";
    } catch (e) {
      delivery = "failed";
      detail = e instanceof Error ? e.message : String(e);
    }
    const reply: SentReply = { key: `${th.key}:${next}`, sourceId: th.sourceId, threadKey: th.key, taskId: t.id, status: next, text, at, delivery, detail };
    await d.store.putReply(reply);
    // A failed delivery is retried next pass; anything else moves the thread on.
    if (delivery !== "failed") await d.store.putThread({ ...th, told: next });
    d.log("reply", { thread: th.key, status: next, delivery, detail });
    out.push(reply);
  }
  return out;
}
