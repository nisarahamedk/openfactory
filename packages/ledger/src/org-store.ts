/**
 * The org the app sets up (name, repos, people, teams, factories, connected sources) and every inbound
 * event the factory received. Same Postgres as the ledger. Org objects are small JSON documents keyed by
 * kind and key, validated by the contracts schemas on the way in and out.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { ConnectedRepo, ConnectedSource, InboundEvent, IntakeResult, OrgFactory, OrgInfo, OrgTeam, Person, ReplyThread, SentReply, type CloudEvent, type SourceKind } from "@openfactory/contracts";
import type { z } from "zod";

export const orgObjects = pgTable(
  "of_org_objects",
  {
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").$type<unknown>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.key] })],
);

export const inboundEvents = pgTable("of_inbound_events", {
  key: text("key").primaryKey(),
  sourceId: text("source_id"),
  kind: text("kind"),
  event: jsonb("event").$type<CloudEvent>().notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" }).notNull(),
  result: jsonb("result").$type<z.infer<typeof IntakeResult>>().notNull(),
});

/** Migration 5 (see migrations.ts). Released: never edit it; add a new numbered migration instead. */
export const ORG_MIGRATION = `
CREATE TABLE IF NOT EXISTS of_org_objects (
  kind text NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (kind, key)
);
CREATE TABLE IF NOT EXISTS of_inbound_events (
  key text PRIMARY KEY,
  source_id text,
  kind text,
  event jsonb NOT NULL,
  received_at timestamptz NOT NULL,
  result jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS of_inbound_events_received ON of_inbound_events (received_at DESC)
`;

// biome-ignore lint: drizzle's PgDatabase needs a query-result HKT; any driver works.
type Db = PgDatabase<any, any, any>;

const KINDS = {
  org: OrgInfo,
  repo: ConnectedRepo,
  person: Person,
  team: OrgTeam,
  factory: OrgFactory,
  source: ConnectedSource,
  thread: ReplyThread,
  reply: SentReply,
} as const;
type Kind = keyof typeof KINDS;
type ValueOf<K extends Kind> = z.infer<(typeof KINDS)[K]>;

export class OrgStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async migrate(): Promise<void> {
    for (const stmt of ORG_MIGRATION.split(";").map((s) => s.trim()).filter(Boolean)) await this.db.execute(sql.raw(stmt));
  }

  private async list<K extends Kind>(kind: K): Promise<ValueOf<K>[]> {
    const rows = await this.db.select().from(orgObjects).where(eq(orgObjects.kind, kind)).orderBy(orgObjects.key);
    const out: ValueOf<K>[] = [];
    for (const r of rows) {
      const v = KINDS[kind].safeParse(r.value);
      if (v.success) out.push(v.data as ValueOf<K>);
    }
    return out;
  }

  private async get<K extends Kind>(kind: K, key: string): Promise<ValueOf<K> | null> {
    const rows = await this.db.select().from(orgObjects).where(and(eq(orgObjects.kind, kind), eq(orgObjects.key, key))).limit(1);
    const v = rows[0] ? KINDS[kind].safeParse(rows[0].value) : null;
    return v?.success ? (v.data as ValueOf<K>) : null;
  }

  private async put<K extends Kind>(kind: K, key: string, value: ValueOf<K>): Promise<ValueOf<K>> {
    const parsed = KINDS[kind].parse(value) as ValueOf<K>;
    await this.db
      .insert(orgObjects)
      .values({ kind, key, value: parsed, updatedAt: this.now() })
      .onConflictDoUpdate({ target: [orgObjects.kind, orgObjects.key], set: { value: parsed, updatedAt: this.now() } });
    return parsed;
  }

  private async remove(kind: Kind, key: string): Promise<boolean> {
    const r = await this.db.delete(orgObjects).where(and(eq(orgObjects.kind, kind), eq(orgObjects.key, key))).returning({ key: orgObjects.key });
    return r.length > 0;
  }

  org = () => this.get("org", "org");
  setOrg = (v: OrgInfo) => this.put("org", "org", v);
  repos = () => this.list("repo");
  addRepo = (v: ConnectedRepo) => this.put("repo", v.repo.toLowerCase(), v);
  removeRepo = (repo: string) => this.remove("repo", repo.toLowerCase());
  people = () => this.list("person");
  person = (login: string) => this.get("person", login.toLowerCase());
  putPerson = (v: Person) => this.put("person", v.login.toLowerCase(), v);
  teams = () => this.list("team");
  team = (slug: string) => this.get("team", slug);
  putTeam = (v: OrgTeam) => this.put("team", v.slug, v);
  removeTeam = (slug: string) => this.remove("team", slug);
  factories = () => this.list("factory");
  putFactory = (v: OrgFactory) => this.put("factory", v.slug, v);
  sources = () => this.list("source");
  putSource = (v: ConnectedSource) => this.put("source", v.id, v);
  removeSource = (id: string) => this.remove("source", id);
  threads = () => this.list("thread");
  putThread = (v: ReplyThread) => this.put("thread", v.key, v);
  putReply = (v: SentReply) => this.put("reply", v.key, v);
  /** Replies sent to chat threads and tickets, newest first. */
  replies = async (limit = 100) => (await this.list("reply")).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);

  /** Keep an inbound event. Returns false when this source + id was already received (CloudEvents dedupe rule). */
  async recordEvent(input: { event: CloudEvent; sourceId: string | null; kind: SourceKind | null; result: z.infer<typeof IntakeResult> }): Promise<boolean> {
    const key = `${input.event.source}#${input.event.id}`;
    const r = await this.db
      .insert(inboundEvents)
      .values({ key, sourceId: input.sourceId, kind: input.kind, event: input.event, receivedAt: this.now(), result: input.result })
      .onConflictDoNothing()
      .returning({ key: inboundEvents.key });
    return r.length > 0;
  }

  async setEventResult(event: CloudEvent, result: z.infer<typeof IntakeResult>): Promise<void> {
    await this.db.update(inboundEvents).set({ result }).where(eq(inboundEvents.key, `${event.source}#${event.id}`));
  }

  async events(opts: { sourceId?: string; limit?: number } = {}): Promise<InboundEvent[]> {
    const q = this.db.select().from(inboundEvents);
    const rows = await (opts.sourceId ? q.where(eq(inboundEvents.sourceId, opts.sourceId)) : q).orderBy(desc(inboundEvents.receivedAt)).limit(Math.min(opts.limit ?? 200, 1000));
    return rows.map((r) =>
      InboundEvent.parse({ key: r.key, sourceId: r.sourceId, kind: r.kind, event: r.event, receivedAt: new Date(r.receivedAt).toISOString(), result: r.result }),
    );
  }
}
