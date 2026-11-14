import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { AppStore } from "./app-store.js";
import { MIGRATIONS, runMigrations } from "./migrations.js";
import { Ledger } from "./store.js";

/**
 * Released migrations, by content hash. A released migration must never change (databases already ran it):
 * add the next version instead, and add its hash here when it ships.
 */
const RELEASED: Record<number, string> = {
  1: "573049a040d4",
  2: "5afc4ddb6df5",
  3: "78329a2e887b",
  4: "aeaf7b21411b",
};

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

describe("migrations", () => {
  it("are numbered 1..n with no gaps, and released ones are unchanged", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    for (const m of MIGRATIONS) if (RELEASED[m.version]) expect([m.version, hash(m.sql)]).toEqual([m.version, RELEASED[m.version]]);
  });

  it("upgrade a database made by the older server, run once, and keep the data", async () => {
    const db = drizzle(new PGlite());
    // The older server made its tables directly, with no of_migrations.
    const old = new Ledger(db);
    await old.migrate();
    await new AppStore(db).migrate();
    await old.createTask({
      id: "task_old" as never,
      factoryVersion: "fv_1",
      source: { kind: "github_issue", repo: { host: "github", owner: "a", name: "b" }, issueNumber: 1, url: "u" },
      title: "t",
      ask: "x",
      harness: { name: "h", model: "m" },
    });

    expect(await runMigrations(db)).toEqual([1, 2, 3, 4, 5]);
    expect(await runMigrations(db)).toEqual([]);
    expect((await new Ledger(db).getTask("task_old" as never))?.title).toBe("t");

    const store = new AppStore(db);
    expect(await store.cursor("github:a/b")).toBeNull();
    await store.setCursor("github:a/b", "2026-11-13T00:00:00Z");
    await store.setCursor("github:a/b", "2026-11-13T01:00:00Z");
    expect(await store.cursor("github:a/b")).toBe("2026-11-13T01:00:00Z");
  });
});
