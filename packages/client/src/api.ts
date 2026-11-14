import { z } from "zod";
import { BenchmarkTask, ConnectedSource, InboundEvent, OrgFactory, OrgState, OrgTeam, Person, LedgerEvent, RolloutState, SavedView, TaskRecord, Team, type LedgerReader, type TaskId, type TaskStatus, type ViewShare } from "@openfactory/contracts";
import { BenchRun } from "@openfactory/bench";
import { FactoryInfo, FactoryView, HealthReport } from "./routes.js";

export interface FactoryApiConfig {
  baseUrl: string;
  /** Bearer token for the factory server, or null if it has no auth. */
  token: string | null;
  fetch?: typeof fetch;
}

/** A failed call to the factory server; `status` is the HTTP status (0 when unreachable). */
export class FactoryApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Accept either a bare array or `{ <key>: [...] }`, since both are common API shapes. */
function listOf<T extends z.ZodType>(item: T, key: string) {
  return z.union([z.array(item), z.object({ [key]: z.array(item) }).transform((o) => o[key] as z.infer<T>[])]);
}
function oneOf<T extends z.ZodType>(item: T, key: string) {
  return z.union([z.object({ [key]: item }).transform((o) => o[key] as z.infer<T>), item]);
}

/** HTTP client for the factory server's /v1 API: a LedgerReader plus the benchmark endpoints. */
export class FactoryApi implements LedgerReader {
  constructor(private readonly cfg: FactoryApiConfig) {}

  private async call<T>(method: "GET" | "POST", path: string, schema: z.ZodType<T>, body: unknown = null): Promise<T> {
    const f = this.cfg.fetch ?? fetch;
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.cfg.token !== null) headers.authorization = `Bearer ${this.cfg.token}`;
    if (body !== null) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await f(new URL(path, this.cfg.baseUrl), { method, headers, body: body === null ? null : JSON.stringify(body) });
    } catch (err) {
      throw new FactoryApiError(0, `factory server unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    if (!res.ok) {
      const msg = z.object({ message: z.string() }).safeParse(safeJson(text));
      throw new FactoryApiError(res.status, msg.success ? msg.data.message : `${method} ${path} failed with ${res.status}`);
    }
    return schema.parse(safeJson(text));
  }

  async getTask(id: TaskId): Promise<TaskRecord | null> {
    try {
      return await this.call("GET", `/v1/tasks/${id}`, oneOf(TaskRecord, "task"));
    } catch (err) {
      if (err instanceof FactoryApiError && err.status === 404) return null;
      throw err;
    }
  }

  listTasks(filter?: { status?: TaskStatus; limit?: number }): Promise<TaskRecord[]> {
    const q = new URLSearchParams();
    if (filter?.status !== undefined) q.set("status", filter.status);
    q.set("limit", String(filter?.limit ?? 200));
    return this.call("GET", `/v1/tasks?${q}`, listOf(TaskRecord, "tasks"));
  }

  events(id: TaskId): Promise<LedgerEvent[]> {
    return this.call("GET", `/v1/tasks/${id}/events`, listOf(LedgerEvent, "events"));
  }

  addToBenchmark(id: TaskId): Promise<BenchmarkTask> {
    return this.call("POST", `/v1/tasks/${id}/benchmark`, oneOf(BenchmarkTask, "task"), {});
  }

  benchTasks(): Promise<BenchmarkTask[]> {
    return this.call("GET", "/v1/bench/tasks", listOf(BenchmarkTask, "tasks"));
  }

  benchRuns(): Promise<BenchRun[]> {
    return this.call("GET", "/v1/bench/runs", listOf(BenchRun, "runs"));
  }

  benchRun(id: string): Promise<BenchRun> {
    return this.call("GET", `/v1/bench/runs/${encodeURIComponent(id)}`, oneOf(BenchRun, "run"));
  }

  /** This factory's version, providers, rules and prompts (secret-looking options redacted by the server). */
  factory(): Promise<FactoryInfo> {
    return this.call("GET", "/v1/factory", oneOf(FactoryInfo, "factory"));
  }

  /** Stop a task: aborts its job, sleeps the environment, marks it failed (stage "cancelled"). */
  cancel(id: TaskId, input: { by?: string; reason?: string } = {}): Promise<TaskRecord> {
    return this.call("POST", `/v1/tasks/${id}/cancel`, oneOf(TaskRecord, "task"), input);
  }

  /** Try a failed or stopped task again. */
  /** Approve the task's PR as `by`. Doesn't merge; it never starts a review round. */
  approve(id: TaskId, input: { by: string; note?: string }): Promise<TaskRecord> {
    return this.call("POST", `/v1/tasks/${id}/approve`, oneOf(TaskRecord, "task"), input);
  }

  retry(id: TaskId, input: { by?: string } = {}): Promise<TaskRecord> {
    return this.call("POST", `/v1/tasks/${id}/retry`, oneOf(TaskRecord, "task"), input);
  }

  /** The factory's start-up checks. */
  health(): Promise<HealthReport> {
    return this.call("GET", "/v1/health", oneOf(HealthReport, "health"));
  }

  /**
   * One turn's transcript (JSONL) from the server's /evidence route; null if missing.
   * `key` comes from a transcript_saved event, e.g. "transcript-1.jsonl".
   */
  async transcript(id: TaskId, key: string): Promise<string | null> {
    const f = this.cfg.fetch ?? fetch;
    const headers: Record<string, string> = {};
    if (this.cfg.token !== null) headers.authorization = `Bearer ${this.cfg.token}`;
    let res: Response;
    try {
      res = await f(new URL(`/evidence/${id}/${encodeURIComponent(key)}`, this.cfg.baseUrl), { headers });
    } catch (err) {
      throw new FactoryApiError(0, `factory server unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new FactoryApiError(res.status, `GET transcript ${key} failed with ${res.status}`);
    return res.text();
  }

  createTask(input: { ask: string; repo: string | null; requestedBy: string; origin?: { label: string; url: string | null } | null; labels?: string[] }): Promise<{ issueUrl: string; repo: string; issueNumber: number }> {
    return this.call("POST", "/v1/tasks", z.object({ issueUrl: z.string(), repo: z.string(), issueNumber: z.number().int() }), input);
  }

  postMessage(id: TaskId, input: { author: string; text: string }): Promise<{ task: TaskRecord; url: string | null }> {
    return this.call("POST", `/v1/tasks/${id}/messages`, z.object({ task: TaskRecord, url: z.string().nullable() }), input);
  }

  teams(): Promise<Team[]> {
    return this.call("GET", "/v1/teams", listOf(Team, "teams"));
  }

  factories(): Promise<{ factories: FactoryView[]; rollouts: RolloutState[] }> {
    return this.call("GET", "/v1/factories", z.object({ factories: z.array(FactoryView), rollouts: z.array(RolloutState) }));
  }

  rollout(factory: string): Promise<{ rollout: RolloutState | null; history: RolloutState[] }> {
    return this.call("GET", `/v1/rollout/${encodeURIComponent(factory)}`, z.object({ rollout: RolloutState.nullable(), history: z.array(RolloutState) }));
  }

  setRollout(factory: string, input: { live: string | null; candidate: string | null; share: number; by: string; note?: string | null }): Promise<RolloutState> {
    return this.call("POST", `/v1/rollout/${encodeURIComponent(factory)}`, oneOf(RolloutState, "rollout"), { note: null, ...input });
  }

  views(viewer: string): Promise<SavedView[]> {
    return this.call("GET", `/v1/views?viewer=${encodeURIComponent(viewer)}`, listOf(SavedView, "views"));
  }

  async view(id: string): Promise<SavedView | null> {
    try {
      return await this.call("GET", `/v1/views/${encodeURIComponent(id)}`, oneOf(SavedView, "view"));
    } catch (err) {
      if (err instanceof FactoryApiError && err.status === 404) return null;
      throw err;
    }
  }

  saveView(input: { id?: string; name: string; path: string; owner: string; share: ViewShare; team: string | null }): Promise<SavedView> {
    return this.call("POST", "/v1/views", oneOf(SavedView, "view"), input);
  }

  async deleteView(id: string, by: string): Promise<boolean> {
    return (await this.call("POST", `/v1/views/${encodeURIComponent(id)}/delete`, z.object({ deleted: z.boolean() }), { by })).deleted;
  }

  org(): Promise<OrgState> {
    return this.call("GET", "/v1/org", oneOf(OrgState, "org"));
  }

  setOrg(input: { name: string; by: string; simulated?: boolean }): Promise<OrgState> {
    return this.call("POST", "/v1/org", oneOf(OrgState, "org"), input);
  }

  connectRepo(input: { repo: string; by: string }): Promise<OrgState> {
    return this.call("POST", "/v1/org/repos", oneOf(OrgState, "org"), input);
  }

  invite(input: { login: string; name?: string | null; email?: string | null; persona: Person["persona"]; role?: Person["role"]; identities?: Person["identities"]; by: string }): Promise<Person> {
    return this.call("POST", "/v1/org/people", oneOf(Person, "person"), input);
  }

  join(login: string): Promise<Person> {
    return this.call("POST", `/v1/org/people/${encodeURIComponent(login)}/join`, oneOf(Person, "person"), {});
  }

  saveTeam(input: Omit<OrgTeam, "createdBy" | "createdAt" | "description" | "scope"> & { description?: string | null; scope?: OrgTeam["scope"]; by: string }): Promise<OrgTeam> {
    return this.call("POST", "/v1/org/teams", oneOf(OrgTeam, "team"), input);
  }

  saveFactory(input: Partial<Omit<OrgFactory, "createdBy" | "createdAt">> & { slug: string; by: string }): Promise<OrgFactory> {
    return this.call("POST", "/v1/org/factories", oneOf(OrgFactory, "factory"), input);
  }

  connectSource(input: Omit<ConnectedSource, "connectedBy" | "connectedAt" | "routes"> & { routes?: Record<string, string>; by: string }): Promise<ConnectedSource> {
    return this.call("POST", "/v1/org/sources", oneOf(ConnectedSource, "source"), input);
  }

  inboundEvents(opts: { source?: string; limit?: number } = {}): Promise<InboundEvent[]> {
    const q = new URLSearchParams();
    if (opts.source) q.set("source", opts.source);
    if (opts.limit) q.set("limit", String(opts.limit));
    return this.call("GET", `/v1/events${q.size ? `?${q}` : ""}`, listOf(InboundEvent, "events"));
  }

  startBenchRun(input: {
    taskIds: string[];
    arms: [{ label: string; factoryVersion: string; model: string; systemPrompt: string }, { label: string; factoryVersion: string; model: string; systemPrompt: string }];
    repeats: number;
    maxCostUsd: number;
  }): Promise<BenchRun> {
    return this.call("POST", "/v1/bench/runs", oneOf(BenchRun, "run"), input);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
