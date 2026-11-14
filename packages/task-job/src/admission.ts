/**
 * Admission control: at most `slots` workspaces awake at once, across live tasks and benchmark replays.
 * A workspace holds a slot from create or wake until sleep or destroy; a task waiting for one stays in
 * "preparing" and its timeline says it is queued. Without this the node over-commits and the kernel kills
 * a worker mid-turn (exit 137), which is worse than waiting.
 */
import type { TaskId, Workspace, WorkspaceHandle } from "@openfactory/contracts";

export type Waiter = { taskId: TaskId; since: string };

export class WorkSlots {
  private held = 0;
  private readonly queue: Array<{ w: Waiter; go: () => void }> = [];

  constructor(
    readonly slots: number,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    if (!(slots >= 1)) throw new Error(`WorkSlots needs at least 1 slot, got ${slots}`);
  }

  get inUse(): number {
    return this.held;
  }
  get waiting(): Waiter[] {
    return this.queue.map((q) => q.w);
  }

  /** Wait for a slot. `onQueued` is told the 1-based place in line when the caller has to wait. */
  async acquire(taskId: TaskId, onQueued?: (position: number) => void | Promise<void>): Promise<void> {
    if (this.held < this.slots && this.queue.length === 0) {
      this.held++;
      return;
    }
    const w = { taskId, since: this.now() };
    const turn = new Promise<void>((go) => this.queue.push({ w, go }));
    await onQueued?.(this.queue.length);
    await turn;
  }

  release(): void {
    const next = this.queue.shift();
    if (next) next.go(); // the slot passes straight to the next in line
    else this.held = Math.max(0, this.held - 1);
  }
}

/**
 * Wrap a workspace provider so every awake workspace holds a slot. Slots follow the workspace id, not the
 * handle: the job sleeps a workspace through a handle it looked up again, so per-handle state would leak.
 */
export function admitted(inner: Workspace, slots: WorkSlots, onQueued?: (taskId: TaskId, position: number) => void | Promise<void>): Workspace {
  const holding = new Set<string>();
  const owner = new Map<string, TaskId>();
  const queued = (taskId: TaskId | undefined) => (taskId && onQueued ? (p: number) => onQueued(taskId, p) : undefined);
  const give = (id: string) => {
    if (holding.delete(id)) slots.release();
  };
  const wrap = (h: WorkspaceHandle): WorkspaceHandle => ({
    id: h.id,
    repoPath: h.repoPath,
    exec: (cmd, opts) => h.exec(cmd, opts),
    spawn: (cmd, opts) => h.spawn(cmd, opts),
    writeFile: (p, c) => h.writeFile(p, c),
    sleep: async () => {
      try {
        await h.sleep();
      } finally {
        give(h.id);
      }
    },
    wake: async () => {
      if (!holding.has(h.id)) {
        await slots.acquire(owner.get(h.id) ?? ("task_unknown" as TaskId), queued(owner.get(h.id)));
        holding.add(h.id);
      }
      try {
        await h.wake();
      } catch (e) {
        give(h.id);
        throw e;
      }
    },
    destroy: async () => {
      try {
        await h.destroy();
      } finally {
        give(h.id);
        owner.delete(h.id);
      }
    },
  });
  return {
    name: inner.name,
    async create(input) {
      await slots.acquire(input.taskId, queued(input.taskId));
      let h: WorkspaceHandle;
      try {
        h = await inner.create(input);
      } catch (e) {
        slots.release();
        throw e;
      }
      holding.add(h.id);
      owner.set(h.id, input.taskId);
      return wrap(h);
    },
    async get(id) {
      const h = await inner.get(id);
      return h ? wrap(h) : null;
    },
  };
}
