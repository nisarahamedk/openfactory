import { z } from "zod";
import { BenchmarkTask, LedgerEvent, TaskRecord, type LedgerReader, type TaskId, type TaskStatus } from "@openfactory/contracts";
import { BenchRun } from "@openfactory/bench";

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
