/**
 * Org pages: Setup (a new org from nothing to its first task), People (who's in the org, their persona,
 * role and ids in each tool), and Sources (connected tools and every event they sent, with what the
 * factory did with it).
 */
import { PERSONA_LABEL, SOURCE_LABEL, type ConnectedSource, type InboundEvent, type OrgState, type Persona, type SourceKind, type Team } from "@openfactory/contracts";
import type { Child } from "hono/jsx";
import { Badge, Empty, Icon, PageHeader, type Tone } from "./ui.js";

const PERSONAS = Object.entries(PERSONA_LABEL) as Array<[Persona, string]>;
const KINDS = (Object.entries(SOURCE_LABEL) as Array<[SourceKind, string]>).filter(([k]) => k !== "github");

/** Where each persona lands after signing in: the page that answers their first question. */
export function homeFor(persona: Persona | null, teams: Team[], login: string): string {
  const team = teams.find((t) => t.members.some((m) => m.login === login));
  switch (persona) {
    case "em":
      return team ? `/teams/${team.slug}` : "/teams";
    case "director":
      return "/insights?by=team";
    case "factory_engineer":
      return `/factories/${team?.factory ?? "default"}`;
    case "platform_director":
      return "/factories";
    case "vp":
      return "/insights?measure=cost_per_merged&by=team";
    default:
      return "/";
  }
}

function Section({ id, n, title, done, sub, children }: { id: string; n: number; title: string; done: boolean; sub: Child; children: Child }) {
  return (
    <section id={id} class="card" style="margin-bottom:16px">
      <div class="head">
        <div style="display:flex;gap:12px;align-items:flex-start">
          <span class={`stepn${done ? " done" : ""}`}>{done ? <Icon name="check" size={14} /> : n}</span>
          <div>
            <h3>{title}</h3>
            <div class="meta">{sub}</div>
          </div>
        </div>
      </div>
      <div style="margin-top:16px;padding-left:36px">{children}</div>
    </section>
  );
}

const field = (label: string, input: Child, hint?: string) => (
  <label class="fld">
    <span>{label}</span>
    {input}
    {hint ? <small class="muted">{hint}</small> : null}
  </label>
);


export function SetupPage({ s, viewer, eventsUrl, teams }: { s: OrgState; viewer: string | null; eventsUrl: string; teams: Team[] }) {
  const done = s.setup.filter((x) => x.done).length;
  const step = (k: string) => s.setup.find((x) => x.key === k)!;
  const allFactories = ["default", ...s.factories.map((f) => f.slug)];
  return (
    <>
      <PageHeader
        title={s.org ? `Set up ${s.org.name}` : "Set up your factory"}
        sub={<>From nothing to a first task: name the org, connect the code and the tools work comes from, make teams with their own factories, and invite people. {viewer ? null : <b>Sign in first; every change records who made it.</b>}</>}
      />
      <div class="card" style="margin-bottom:16px">
        <div class="head"><h3>{done === s.setup.length ? "Setup is done" : `${done} of ${s.setup.length} steps done`}</h3><a class="btn" href="/tasks/new"><Icon name="plus" />Ask for a task</a></div>
        <div class="progress"><i style={`width:${Math.round((done / s.setup.length) * 100)}%`} /></div>
        <ul class="timeline" style="margin-top:14px">
          {s.setup.map((x) => (
            <li><span class={`dot ${x.done ? "good" : ""}`} /><span><a class="link" href={x.href}>{x.title}</a> <span class="muted">· {x.detail}</span></span><span>{x.done ? <Badge tone="good">Done</Badge> : <Badge>To do</Badge>}</span></li>
          ))}
        </ul>
      </div>

      <Section id="org" n={1} title="Name your org" done={step("org").done} sub="Shown across the app, in Slack replies and in exports.">
        <form method="post" action="/setup/org" class="form">
          {field("Org name", <input class="in" name="name" required maxlength={80} value={s.org?.name ?? ""} placeholder="Acme" />)}
          <button class="btn primary" type="submit">Save</button>
        </form>
      </Section>

      <Section id="repo" n={2} title="Connect a repo" done={step("repo").done} sub="The factory opens PRs here with a token scoped to the repo. Several teams can share one repo; each team's scope says which part is theirs.">
        {s.repos.length ? <div style="margin-bottom:8px">{s.repos.map((r) => <span class="pill mono">{r.repo}</span>)}</div> : null}
        <form method="post" action="/setup/repo" class="form">
          {field("Repo", <input class="in" name="repo" required pattern="[\w.-]+/[\w.-]+" placeholder="owner/name" />)}
          <button class="btn primary" type="submit">Connect</button>
        </form>
      </Section>

      <Section id="sources" n={3} title="Connect where work comes from, and where outcomes land" done={step("sources").done} sub={<>Every tool sends <a class="link" href="https://cloudevents.io">CloudEvents</a> to one endpoint. Asks start tasks; deploys, incidents and reverts become outcomes on the task that caused them. CI/CD tools can send <a class="link" href="https://cdevents.dev">CDEvents</a> as they are.</>}>
        <SourcesTable sources={s.sources} />
        <p class="note" style="margin-top:12px">Endpoint: <code>POST {eventsUrl}</code> with the factory's API token. <a class="link" href="/sources">See what arrived</a>.</p>
        <form method="post" action="/setup/source" class="form">
          {field("Tool", <select class="in" name="kind">{KINDS.map(([k, l]) => <option value={k}>{l}</option>)}</select>)}
          {field("Name", <input class="in" name="name" required placeholder="Acme Slack" />)}
          {field("Id", <input class="in" name="id" required pattern="[a-z0-9][a-z0-9-]*" placeholder="slack" />)}
          {field("Event source", <input class="in" name="ceSource" required placeholder="https://acme.slack.com" />, "The CloudEvents source prefix")}
          <div class="fld wide"><span>Used for</span><div class="checks">
            <label><input type="checkbox" name="uses" value="asks" /> asks</label>
            <label><input type="checkbox" name="uses" value="deploys" /> deploys</label>
            <label><input type="checkbox" name="uses" value="outcomes" /> incidents and reverts</label>
          </div></div>
          {field("Route to teams", <input class="in" name="routes" placeholder="C024WEB=web, PAY=payments" />, "Channel, project or service = team")}
          {field("Reply to askers", <select class="in" name="replyMode"><option value="record">Keep replies in the app</option><option value="post">Post in the thread or ticket</option><option value="cloudevents">Send CloudEvents to a URL</option></select>, "Where the factory answers the person who asked")}
          {field("Credentials variable", <input class="in" name="replyTokenEnv" placeholder="SLACK_BOT_TOKEN" />, "Name of the server env var, never the value")}
          {field("Reply URL", <input class="in" name="replyUrl" placeholder="https://events.acme.dev/factory" />, "For CloudEvents")}
          <button class="btn primary" type="submit">Connect</button>
        </form>
      </Section>

      <Section id="factories" n={4} title="Make team factories" done={s.factories.length > 0} sub="A team factory changes only what it needs on top of the org default: extra scorers, its own benchmarks, an OpenWorld world, and which paths make a PR high or low risk. Org scorers always apply.">
        <div class="card flush" style="margin-bottom:12px"><div class="scroll"><table class="tbl">
          <thead><tr><th>Factory</th><th>Adds scorers</th><th>Benchmarks</th><th>World</th><th>High-risk paths</th></tr></thead>
          <tbody>
            <tr><td><a class="title" href="/factories/default">default</a><div class="muted">The org default</div></td><td class="muted">org scorers</td><td class="muted">—</td><td class="muted">—</td><td class="muted">—</td></tr>
            {s.factories.map((f) => (
              <tr><td><a class="title" href={`/factories/${f.slug}`}>{f.slug}</a><div class="muted" style="white-space:normal;max-width:36ch">{f.description}</div></td><td>{f.scorers.join(", ") || "—"}</td><td>{f.benchmarks.join(", ") || "—"}</td><td>{f.world ?? "—"}</td><td class="mono">{f.mergeRisk?.high.join(", ") || "—"}</td></tr>
            ))}
          </tbody>
        </table></div></div>
        <form method="post" action="/setup/factory" class="form">
          {field("Slug", <input class="in" name="slug" required pattern="[a-z0-9][a-z0-9-]*" placeholder="payments" />)}
          {field("What it changes", <input class="in" name="description" placeholder="Money rules reviewer, ledger checks" />)}
          {field("Extra scorers", <input class="in" name="scorers" placeholder="ledger-balances" />, "Comma separated")}
          {field("Benchmarks", <input class="in" name="benchmarks" placeholder="payments-core" />)}
          {field("OpenWorld world", <input class="in" name="world" placeholder="payments-30d" />)}
          {field("High-risk paths", <input class="in" name="high" placeholder="src/billing/**, drizzle/**" />)}
          {field("Low-risk paths", <input class="in" name="low" placeholder="docs/**, **/*.md" />)}
          <button class="btn primary" type="submit">Save factory</button>
        </form>
      </Section>

      <Section id="teams" n={5} title="Create teams" done={step("teams").done && step("factories").done} sub="Teams come from your directory (GitHub teams, SSO groups) or are made here. A team's scope is the part of a shared repo it owns; its factory is where its tasks run.">
        {s.teams.length ? (
          <div class="card flush" style="margin-bottom:12px"><div class="scroll"><table class="tbl">
            <thead><tr><th>Team</th><th>Repos</th><th>Scope</th><th>Factory</th><th class="r">People</th></tr></thead>
            <tbody>{s.teams.map((t) => (
              <tr><td><a class="title" href={`/teams/${t.slug}`}>{t.name}</a><div class="muted" style="white-space:normal;max-width:36ch">{t.description}</div></td><td class="mono">{t.repos.join(", ")}</td><td class="mono" style="white-space:normal">{[...t.scope.paths, ...t.scope.labels.map((l) => `label:${l}`)].join(", ") || "whole repo"}</td><td><a class="link" href={`/factories/${t.factory}`}>{t.factory}</a></td><td class="r num">{t.members.length}</td></tr>
            ))}</tbody>
          </table></div></div>
        ) : teams.length ? <p class="note">Your directory already has {teams.length} team{teams.length === 1 ? "" : "s"}: {teams.map((t) => t.name).join(", ")}.</p> : null}
        <form method="post" action="/setup/team" class="form">
          {field("Slug", <input class="in" name="slug" required pattern="[a-z0-9][a-z0-9-]*" placeholder="web" />)}
          {field("Name", <input class="in" name="name" required placeholder="Web" />)}
          {field("Repos", <input class="in" name="repos" placeholder="owner/name" value={s.repos[0]?.repo ?? ""} />)}
          {field("Factory", <select class="in" name="factory">{allFactories.map((f) => <option value={f}>{f}</option>)}</select>)}
          {field("Owns paths", <input class="in" name="paths" placeholder="src/routes/**, marketing/**" />)}
          {field("Owns labels", <input class="in" name="labels" placeholder="ui, pricing" />)}
          {field("Members", <input class="in" name="members" placeholder="maya, li (first one is maintainer)" />)}
          {field("What it does", <input class="in" name="description" placeholder="Marketing site and app screens" />)}
          <button class="btn primary" type="submit">Save team</button>
        </form>
      </Section>

      <Section id="people" n={6} title="Invite people" done={step("people").done} sub="A persona picks a person's home page; the role decides what they can change. Their ids in Slack, Teams and Jira let an ask there count as theirs.">
        <PeopleTable s={s} teams={teams} compact />
        <form method="post" action="/setup/person" class="form">
          {field("GitHub login", <input class="in" name="login" required pattern="[A-Za-z0-9][A-Za-z0-9-]*" placeholder="maya" />)}
          {field("Name", <input class="in" name="name" placeholder="Maya Chen" />)}
          {field("Email", <input class="in" name="email" type="email" placeholder="maya@acme.dev" />)}
          {field("Persona", <select class="in" name="persona">{PERSONAS.map(([k, l]) => <option value={k}>{l}</option>)}</select>)}
          {field("Role", <select class="in" name="role"><option value="">From persona</option><option value="viewer">Viewer</option><option value="engineer">Engineer</option><option value="admin">Admin</option></select>)}
          {field("Slack id", <input class="in" name="slack" placeholder="U024BE7LH" />)}
          {field("Teams (Entra) id", <input class="in" name="msteams" placeholder="aad object id" />)}
          {field("Jira account id", <input class="in" name="jira" placeholder="5b10ac8d82e05b22cc7d4ef5" />)}
          <button class="btn primary" type="submit">Invite</button>
        </form>
      </Section>
    </>
  );
}

function SourcesTable({ sources }: { sources: ConnectedSource[] }) {
  if (!sources.length) return <p class="muted" style="margin:0">Nothing connected yet.</p>;
  return (
    <div class="card flush"><div class="scroll"><table class="tbl">
      <thead><tr><th>Tool</th><th>Event source</th><th>Used for</th><th>Routes</th><th>Replies</th><th>Connected</th></tr></thead>
      <tbody>{sources.map((x) => (
        <tr><td><a class="title" href={`/sources?source=${x.id}`}>{x.name}</a><div class="muted">{SOURCE_LABEL[x.kind]}</div></td><td class="mono">{x.ceSource}</td><td>{x.uses.join(", ")}</td><td class="mono" style="white-space:normal">{Object.entries(x.routes).map(([k, v]) => `${k} → ${v}`).join(", ") || "—"}</td><td>{!x.uses.includes("asks") ? <span class="muted">—</span> : x.reply?.mode === "post" ? `in the ${x.kind === "jira" ? "ticket" : "thread"}` : x.reply?.mode === "cloudevents" ? "CloudEvents" : <span class="muted">kept in the app</span>}</td><td class="muted">{x.connectedBy ? `by ${x.connectedBy}, ` : ""}{x.connectedAt.slice(0, 10)}</td></tr>
      ))}</tbody>
    </table></div></div>
  );
}

export function PeopleTable({ s, teams, compact = false }: { s: OrgState; teams: Team[]; compact?: boolean }) {
  if (!s.people.length) return <Empty title="Nobody yet">Invite the first people below.</Empty>;
  return (
    <div class="card flush" style={compact ? "margin-bottom:12px" : ""}><div class="scroll"><table class="tbl">
      <thead><tr><th>Person</th><th>Persona</th><th>Role</th><th>Teams</th><th>Linked in</th><th>Status</th></tr></thead>
      <tbody>{s.people.map((p) => {
        const theirs = teams.filter((t) => t.members.some((m) => m.login === p.login));
        const linked = (Object.entries(p.identities) as Array<[string, string | undefined]>).filter(([, v]) => v).map(([k]) => SOURCE_LABEL[k as SourceKind] ?? k);
        return (
          <tr>
            <td><a class="title" href={`/people/${p.login}`}>{p.name ?? p.login}</a><div class="muted mono" style="font-size:12px">{p.login}{p.email ? ` · ${p.email}` : ""}</div></td>
            <td>{PERSONA_LABEL[p.persona]}</td>
            <td>{p.role}</td>
            <td>{theirs.map((t) => <a class="pill" href={`/teams/${t.slug}`}>{t.name}</a>)}</td>
            <td class="muted">{linked.join(", ") || "—"}</td>
            <td>{p.status === "joined" ? <Badge tone="good">Joined</Badge> : <Badge tone="warn">Invited</Badge>}</td>
          </tr>
        );
      })}</tbody>
    </table></div></div>
  );
}

export function PeoplePage({ s, teams }: { s: OrgState; teams: Team[] }) {
  const by = (p: Persona) => s.people.filter((x) => x.persona === p).length;
  return (
    <>
      <PageHeader title="People" sub="Everyone in the org, with the persona that picks their home page and the role that decides what they can change." >
        <a class="btn" href="/setup#people"><Icon name="plus" />Invite</a>
      </PageHeader>
      <div class="readout" style="--cols:3">
        <div><div class="k">People</div><div class="v num">{s.people.length}</div><div class="c">{s.people.filter((p) => p.status === "joined").length} joined</div></div>
        <div><div class="k">Building</div><div class="v num">{by("engineer") + by("em") + by("director")}</div><div class="c">engineers, managers, directors</div></div>
        <div><div class="k">Running the factory</div><div class="v num">{by("factory_engineer") + by("platform_director")}</div><div class="c">factory engineers, platform directors</div></div>
      </div>
      <PeopleTable s={s} teams={teams} />
    </>
  );
}

const RESULT_TONE: Record<InboundEvent["result"]["kind"], Tone> = { ask: "good", signal: "good", outcome: "warn", ignored: "neutral", error: "bad" };
const RESULT_WORD: Record<InboundEvent["result"]["kind"], string> = { ask: "Started work", signal: "Moved a PR", outcome: "Outcome", ignored: "Ignored", error: "Failed" };

const DELIVERY_TONE = { sent: "good", recorded: "info", failed: "bad" } as const;
const STATUS_WORD: Record<string, string> = { working: "Picked up", awaiting_review: "Ready for review", merged: "Merged", closed: "Closed", failed: "Couldn't finish" };

/** What askers were told in their own thread, and whether it reached them. */
function Replies({ s }: { s: OrgState }) {
  const rs = s.replies ?? [];
  if (!rs.length) return null;
  const name = (id: string) => s.sources.find((x) => x.id === id)?.name ?? id;
  return (
    <>
      <div class="section-title">Replies to askers <span class="n">{rs.length}</span></div>
      <div class="card flush" style="margin-bottom:12px"><div class="scroll"><table class="tbl">
        <thead><tr><th>When</th><th>Where</th><th>News</th><th>What they were told</th><th>Delivery</th></tr></thead>
        <tbody>{rs.map((r) => (
          <tr>
            <td class="muted num">{r.at.slice(5, 16).replace("T", " ")}</td>
            <td>{name(r.sourceId)}</td>
            <td><a class="link" href={`/tasks/${r.taskId}`}>{STATUS_WORD[r.status] ?? r.status}</a></td>
            <td class="wrapcell t2" style="font-size:13px;min-width:260px">{r.text}</td>
            <td class="wrapcell"><Badge tone={DELIVERY_TONE[r.delivery]}>{r.delivery}</Badge>{r.detail ? <div class="muted" style="font-size:12px;margin-top:2px">{r.detail}</div> : null}</td>
          </tr>
        ))}</tbody>
      </table></div></div>
    </>
  );
}

export function SourcesPage({ s, events, only, eventsUrl }: { s: OrgState; events: InboundEvent[]; only: string | null; eventsUrl: string }) {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.result.kind, (counts.get(e.result.kind) ?? 0) + 1);
  return (
    <>
      <PageHeader title="Sources" sub={<>The tools connected to the factory and every event they sent. Send <a class="link" href="https://cloudevents.io">CloudEvents</a> to <code>{eventsUrl}</code>; CI/CD and incident tools can send <a class="link" href="https://cdevents.dev">CDEvents</a>.</>}>
        <a class="btn" href="/setup#sources"><Icon name="plus" />Connect a tool</a>
      </PageHeader>
      <SourcesTable sources={s.sources} />
      <Replies s={s} />
      <div class="section-title">{only ? <>Events from {s.sources.find((x) => x.id === only)?.name ?? only} <a class="link muted" href="/sources" style="font-size:13px;font-weight:400">show all</a></> : "Recent events"}<span class="n">{events.length}{counts.size ? ` · ${[...counts].map(([k, n]) => `${n} ${RESULT_WORD[k as keyof typeof RESULT_WORD].toLowerCase()}`).join(", ")}` : ""}</span></div>
      <div class="card flush"><div class="scroll"><table class="tbl">
        <thead><tr><th>Received</th><th>Tool</th><th>Event</th><th>What happened</th><th>Task</th></tr></thead>
        <tbody>
          {events.length === 0 ? <tr><td colspan={5}><Empty title="No events yet">Connected tools' events show here as they arrive.</Empty></td></tr> : null}
          {events.map((e) => (
            <tr>
              <td class="muted num">{e.receivedAt.slice(5, 16).replace("T", " ")}</td>
              <td>{e.kind ? SOURCE_LABEL[e.kind] : "unknown"}</td>
              <td class="mono" style="font-size:12px">{e.event.type}{e.event.subject ? <div class="muted">{e.event.subject}</div> : null}</td>
              <td class="wrapcell"><Badge tone={RESULT_TONE[e.result.kind]}>{RESULT_WORD[e.result.kind]}</Badge><div class="t2" style="font-size:13px;margin-top:2px">{e.result.url ? <a class="link" href={e.result.url}>{e.result.detail}</a> : e.result.detail}</div></td>
              <td>{e.result.taskId ? <a class="link mono" href={`/tasks/${e.result.taskId}`}>{e.result.taskId}</a> : <span class="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table></div></div>
    </>
  );
}
