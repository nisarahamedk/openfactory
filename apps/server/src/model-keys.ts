/**
 * Per-task model keys on LiteLLM: each task's agent gets its own key with the task's budget, so one runaway
 * task can't spend the factory's whole budget, and the shared key never enters a sandbox. The key value is
 * derived from the task id (HMAC with the master key), so nothing secret is stored and a restart finds it again.
 */
import { createHmac } from "node:crypto";
import type { ModelKeys } from "@openfactory/task-job";

export function liteLlmModelKeys(opts: {
  adminUrl: string; // e.g. http://litellm.factory.svc:4000
  masterKey: string;
  maxBudgetUsd: number;
  models: string[];
  envNames: { key: string }; // which env var the agent reads its key from
  fetch?: typeof fetch;
}): ModelKeys {
  const f = opts.fetch ?? fetch;
  const keyFor = (taskId: string) => `sk-task-${createHmac("sha256", opts.masterKey).update(taskId).digest("hex").slice(0, 40)}`;
  const call = (path: string, body: unknown) =>
    f(`${opts.adminUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.masterKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    async forTask(taskId) {
      const key = keyFor(taskId);
      const info = await f(`${opts.adminUrl.replace(/\/$/, "")}/key/info?key=${encodeURIComponent(key)}`, {
        headers: { authorization: `Bearer ${opts.masterKey}` },
      });
      if (!info.ok) {
        const res = await call("/key/generate", { key, key_alias: taskId, max_budget: opts.maxBudgetUsd, models: opts.models, metadata: { taskId } });
        if (!res.ok) throw new Error(`LiteLLM key for ${taskId}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      }
      return { [opts.envNames.key]: key };
    },
    async revoke(taskId) {
      await call("/key/delete", { keys: [keyFor(taskId)] }).catch(() => undefined);
    },
  };
}
