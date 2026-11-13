import { PGlite } from "@electric-sql/pglite";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import { JobLog, LeaseLost, runMigrations } from "@openfactory/ledger";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { PostgresJobStorage } from "./pg-storage.js";

/** Subset matching, as the suite means it: every key of `expected` is in `actual` with a matching value. */
function partial(actual: unknown, expected: unknown): void {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    expect(actual).toBeTypeOf("object");
    for (const [k, v] of Object.entries(expected)) partial((actual as Record<string, unknown>)[k], v);
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual)).toBe(true);
    expect((actual as unknown[]).length).toBe(expected.length);
    expected.forEach((v, i) => partial((actual as unknown[])[i], v));
  } else expect(actual).toEqual(expected);
}

const db = drizzle(new PGlite());
const log = new JobLog(db);
const ready = runMigrations(db);
let n = 0;

/** pi-durable's in-memory state, to compare a storage with the one rebuilt from its log. */
const stateOf = (s: PostgresJobStorage) => {
  const mem = (s as unknown as { mem: { state: unknown; nextSeq: number } }).mem;
  return { state: mem.state, nextSeq: mem.nextSeq };
};

const cases = createStorageConformance({
  assertions: {
    ok: (v, m) => expect(v, m).toBeTruthy(),
    strictEqual: (a, b) => expect(a).toBe(b),
    deepEqual: (a, b) => expect(a).toEqual(b),
    partialDeepEqual: partial,
    greaterThan: (a, b) => expect(a).toBeGreaterThan(b),
    rejects: async (p, m) => {
      await expect(p).rejects.toThrow(m);
    },
  },
  // Each case gets a fresh task; afterwards the job is reopened from Postgres and must hold exactly the same state.
  withStorage: async (use) => {
    await ready;
    const taskId = `task_conf_${n++}`;
    const lease = (await log.acquire(taskId, "srv-a", 60_000))!;
    const s = await PostgresJobStorage.open(log, lease, ctx);
    const before = () => structuredClone(stateOf(s));
    let snapshot: ReturnType<typeof stateOf> | null = null;
    const close = s.close.bind(s);
    s.close = async (c) => {
      snapshot ??= before();
      return close(c);
    };
    await use(s);
    snapshot ??= before();
    const again = await PostgresJobStorage.open(log, lease, ctx);
    expect(stateOf(again)).toEqual(snapshot);
  },
});

describe("Postgres job storage: pi-durable's storage conformance, and the same state after replay", () => {
  for (const c of cases) it(c.name, () => c.run(), 30_000);
});

describe("job leases", () => {
  it("let one server run a task at a time, and fence out one whose lease was taken over", async () => {
    await ready;
    const a = (await log.acquire("task_lease", "srv-a", 60_000))!;
    expect(await log.acquire("task_lease", "srv-b", 60_000)).toBeNull();
    expect(await log.renew(a, 60_000)).toBe(true);

    // srv-a stalls past its lease; srv-b takes the task over.
    await log.release(a);
    const b = (await log.acquire("task_lease", "srv-b", 60_000))!;
    expect(b.epoch).toBeGreaterThan(a.epoch);
    expect(await log.renew(a, 60_000)).toBe(false);
    await expect(log.append(a, [{ seq: 1, writes: "[]" }])).rejects.toBeInstanceOf(LeaseLost);
    await log.append(b, [{ seq: 1, writes: "[]" }]);
    expect(await log.commits("task_lease")).toEqual([{ seq: 1, writes: "[]" }]);
  });

  it("stop the storage after a refused write; reopening replays only what Postgres has", async () => {
    await ready;
    const a = (await log.acquire("task_fenced", "srv-a", 60_000))!;
    const s = await PostgresJobStorage.open(log, a, ctx);
    const id = await s.mintId();
    const write = { type: "conversation", value: { id, parentId: undefined, ownership: { kind: "session" }, createdAt: 1 } } as never;
    await log.release(a);
    const b = (await log.acquire("task_fenced", "srv-b", 60_000))!;
    await expect(s.commit([[write]], () => {}, ctx)).rejects.toBeInstanceOf(LeaseLost);
    await expect(s.task(1 as never, ctx)).rejects.toThrow("reopen it");
    const fresh = await PostgresJobStorage.open(log, b, ctx);
    expect(await log.commits("task_fenced")).toEqual([]);
    expect(await fresh.conversation(id as never, ctx)).toBeUndefined();
  });
});
