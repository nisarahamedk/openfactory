/**
 * App state that isn't part of any one task: saved views and each factory's rollout (live version,
 * candidate and its share of new tasks). Same Postgres as the ledger, separate tables.
 */
import { randomBytes } from "node:crypto";
import { and, desc, eq, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { RolloutState, SavedView, ViewShare } from "@openfactory/contracts";

export const views = pgTable("of_views", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  path: text("path").notNull(),
  owner: text("owner").notNull(),
  share: text("share").notNull(),
  team: text("team"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
});

export const rollouts = pgTable("of_rollouts", {
  factory: text("factory").primaryKey(),
  state: jsonb("state").$type<RolloutState>().notNull(),
  history: jsonb("history").$type<RolloutState[]>().notNull(),
});

export const APP_MIGRATION = `
CREATE TABLE IF NOT EXISTS of_views (
  id text PRIMARY KEY,
  name text NOT NULL,
  path text NOT NULL,
  owner text NOT NULL,
  share text NOT NULL,
  team text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS of_views_owner ON of_views (owner);
CREATE TABLE IF NOT EXISTS of_rollouts (
  factory text PRIMARY KEY,
  state jsonb NOT NULL,
  history jsonb NOT NULL
);
`;

// biome-ignore lint: drizzle's PgDatabase needs a query-result HKT; any driver works.
type Db = PgDatabase<any, any, any>;

const toView = (r: typeof views.$inferSelect): SavedView => ({
  id: r.id,
  name: r.name,
  path: r.path,
  owner: r.owner,
  share: ViewShare.catch("me").parse(r.share),
  team: r.team,
  createdAt: new Date(r.createdAt).toISOString(),
  updatedAt: new Date(r.updatedAt).toISOString(),
});

export class AppStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async migrate(): Promise<void> {
    for (const stmt of APP_MIGRATION.split(";").map((s) => s.trim()).filter(Boolean)) await this.db.execute(sql.raw(stmt));
  }

  /**
   * Views `viewer` may see: their own, the org's, and their teams'. Views shared by link are listed only
   * for their owner; anyone with the id can open one.
   */
  async listViews(viewer: { login: string; teams: string[] }): Promise<SavedView[]> {
    const conds = [eq(views.owner, viewer.login), eq(views.share, "org")];
    for (const t of viewer.teams) conds.push(and(eq(views.share, "team"), eq(views.team, t))!);
    const rows = await this.db.select().from(views).where(or(...conds)).orderBy(desc(views.updatedAt)).limit(200);
    return rows.map(toView);
  }

  async getView(id: string): Promise<SavedView | null> {
    const rows = await this.db.select().from(views).where(eq(views.id, id)).limit(1);
    return rows[0] ? toView(rows[0]) : null;
  }

  async saveView(input: { id?: string; name: string; path: string; owner: string; share: ViewShare; team: string | null }): Promise<SavedView> {
    const at = this.now();
    if (input.id) {
      const existing = await this.getView(input.id);
      if (existing && existing.owner === input.owner) {
        await this.db.update(views).set({ name: input.name, path: input.path, share: input.share, team: input.team, updatedAt: at }).where(eq(views.id, input.id));
        return { ...existing, name: input.name, path: input.path, share: input.share, team: input.team, updatedAt: at };
      }
    }
    const view: SavedView = { id: `view_${randomBytes(6).toString("hex")}`, name: input.name, path: input.path, owner: input.owner, share: input.share, team: input.share === "team" ? input.team : null, createdAt: at, updatedAt: at };
    await this.db.insert(views).values(view);
    return view;
  }

  /** Only the owner deletes a view. Returns whether one was deleted. */
  async deleteView(id: string, owner: string): Promise<boolean> {
    const rows = await this.db.delete(views).where(and(eq(views.id, id), eq(views.owner, owner))).returning({ id: views.id });
    return rows.length > 0;
  }

  async rollout(factory: string): Promise<{ state: RolloutState; history: RolloutState[] } | null> {
    const rows = await this.db.select().from(rollouts).where(eq(rollouts.factory, factory)).limit(1);
    return rows[0] ? { state: rows[0].state, history: rows[0].history } : null;
  }

  async listRollouts(): Promise<RolloutState[]> {
    return (await this.db.select().from(rollouts)).map((r) => r.state);
  }

  /** Replace a factory's rollout; the previous state goes to its history (newest first, last 50 kept). */
  async setRollout(input: Omit<RolloutState, "updatedAt">): Promise<RolloutState> {
    const state: RolloutState = RolloutState.parse({ ...input, updatedAt: this.now() });
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(rollouts).where(eq(rollouts.factory, input.factory)).for("update");
      const prev = rows[0];
      if (!prev) {
        await tx.insert(rollouts).values({ factory: input.factory, state, history: [] });
      } else {
        await tx.update(rollouts).set({ state, history: [prev.state, ...prev.history].slice(0, 50) }).where(eq(rollouts.factory, input.factory));
      }
      return state;
    });
  }
}
