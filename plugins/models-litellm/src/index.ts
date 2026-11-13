/**
 * ModelGateway on LiteLLM. Each task's agent gets its own LiteLLM key with the
 * task's budget; the org's provider keys stay inside LiteLLM. The key value is
 * derived from the task id (HMAC with the master key), so nothing secret is
 * stored and a restarted factory finds the same key again.
 */
import { createHmac } from "node:crypto";
import { z } from "zod";
import type { ModelGateway, TaskId } from "@openfactory/contracts";

export interface LiteLlmGatewayOptions {
  /** Admin API, e.g. http://litellm.factory.svc:4000. */
  adminUrl: string;
  masterKey: string;
  /** Base URL the agent uses, as reachable from the workspace (often the same as adminUrl). */
  agentBaseUrl: string;
  /** Models a task key may call. */
  models: string[];
  /** Env var names the agent reads (Anthropic-style by default). baseUrl null: the base URL is set elsewhere. */
  envNames: { baseUrl: string | null; key: string };
  fetch: typeof fetch;
}

/** LiteLLM refused an admin call. */
export class LiteLlmRequestFailed extends Error {
  readonly code = "litellm_request_failed" as const;
  constructor(
    readonly path: string,
    readonly status: number,
    body: string,
  ) {
    super(`LiteLLM ${path} failed with ${status}: ${body.slice(0, 300)}`);
  }
}

const KeyInfo = z.object({ info: z.object({ spend: z.number().nullable().optional() }).passthrough() });

export class LiteLlmGateway implements ModelGateway {
  readonly name = "litellm";

  constructor(private readonly options: LiteLlmGatewayOptions) {}

  /** The task's key. Derived, so it is the same after a restart. */
  keyFor(taskId: TaskId): string {
    return `sk-task-${createHmac("sha256", this.options.masterKey).update(taskId).digest("hex").slice(0, 40)}`;
  }

  async forTask(taskId: TaskId, budget: { usd: number }): Promise<Record<string, string>> {
    const key = this.keyFor(taskId);
    const info = await this.get(`/key/info?key=${encodeURIComponent(key)}`);
    if (info.status === 404 || info.status === 400 || info.status === 401) {
      // LiteLLM answers an unknown key with 404 or 400 (version-dependent).
      await this.post("/key/generate", {
        key,
        key_alias: taskId,
        max_budget: budget.usd,
        models: this.options.models,
        metadata: { taskId, factory: "openfactory" },
      });
    } else if (!info.ok) {
      throw new LiteLlmRequestFailed("/key/info", info.status, await info.text());
    }
    const { baseUrl, key: keyName } = this.options.envNames;
    return baseUrl === null ? { [keyName]: key } : { [baseUrl]: this.options.agentBaseUrl, [keyName]: key };
  }

  async spend(taskId: TaskId): Promise<{ usd: number } | null> {
    const res = await this.get(`/key/info?key=${encodeURIComponent(this.keyFor(taskId))}`);
    if (!res.ok) return null;
    const parsed = KeyInfo.safeParse(await res.json());
    if (!parsed.success) return null;
    return { usd: parsed.data.info.spend ?? 0 };
  }

  async revoke(taskId: TaskId): Promise<void> {
    const res = await this.options.fetch(this.url("/key/delete"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ keys: [this.keyFor(taskId)] }),
    });
    // Deleting a key that is already gone is fine.
    if (!res.ok && res.status !== 404 && res.status !== 400) {
      throw new LiteLlmRequestFailed("/key/delete", res.status, await res.text());
    }
  }

  private url(path: string): string {
    return `${this.options.adminUrl.replace(/\/$/, "")}${path}`;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.options.masterKey}`, "content-type": "application/json" };
  }

  private get(path: string): Promise<Response> {
    return this.options.fetch(this.url(path), { headers: this.headers() });
  }

  private async post(path: string, body: unknown): Promise<void> {
    const res = await this.options.fetch(this.url(path), { method: "POST", headers: this.headers(), body: JSON.stringify(body) });
    if (!res.ok) throw new LiteLlmRequestFailed(path, res.status, await res.text());
  }
}

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key];
  if (value === undefined || value === "") throw new Error(`models-litellm needs ${key}`);
  return value;
}

/** Builds the gateway from settings. See README.md. */
export function fromEnv(env: Env): LiteLlmGateway {
  const adminUrl = required(env, "LITELLM_ADMIN_URL");
  return new LiteLlmGateway({
    adminUrl,
    masterKey: required(env, "LITELLM_MASTER_KEY"),
    agentBaseUrl: env.MODEL_PROXY_URL ?? adminUrl,
    models: required(env, "TASK_KEY_MODELS").split(",").map((m) => m.trim()).filter((m) => m !== ""),
    envNames: { baseUrl: env.MODEL_ENV_BASE_URL ?? "ANTHROPIC_BASE_URL", key: env.MODEL_ENV_KEY ?? "ANTHROPIC_API_KEY" },
    fetch,
  });
}

export const createLiteLlmGateway = (options: LiteLlmGatewayOptions): LiteLlmGateway => new LiteLlmGateway(options);
