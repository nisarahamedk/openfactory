import { z } from "zod";
import { mergeOf, type FoundOutcome, type MergedTask, type MetricsSink, type Outcome, type OutcomeSource, type TaskRecord } from "@openfactory/contracts";
import { latestScores } from "@openfactory/scoring";
import { Deployment, Incident, type Cell } from "./store.js";

/** The custom table the factory writes: one row per task, joinable to PRs by repo + pr_number. */
export const FACTORY_TASKS_TABLE = "factory_tasks";

const COLUMNS = [
  "task_id", "factory_version", "repo", "pr_number", "pr_url", "status", "harness", "model",
  "cost_usd", "input_tokens", "output_tokens", "review_rounds", "human_comments",
  "merged", "ci_first_pass", "lead_time_s", "evidence_count", "created_at", "updated_at",
] as const;

/** Flatten one task record into a factory_tasks row. Scores come from the latest scorer versions. */
export function taskRow(r: TaskRecord): Record<(typeof COLUMNS)[number], Cell> {
  const scores = latestScores(r.scores);
  const val = (name: string): number | null => scores.get(name)?.value ?? null;
  const ci = val("facts.ci_first_pass");
  return {
    task_id: r.id,
    factory_version: r.factoryVersion,
    repo: `${r.source.repo.owner}/${r.source.repo.name}`,
    pr_number: r.pr?.number ?? null,
    pr_url: r.pr?.url ?? null,
    status: r.status,
    harness: r.harness.name,
    model: r.harness.model,
    cost_usd: r.usage.costUsd,
    input_tokens: r.usage.inputTokens,
    output_tokens: r.usage.outputTokens,
    review_rounds: r.people.reviewRounds,
    human_comments: r.people.comments,
    merged: r.status === "merged",
    ci_first_pass: ci === null ? null : ci === 1,
    lead_time_s: val("facts.lead_time_s"),
    evidence_count: r.evidence.length,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

/** Where the fake DX lives and the bearer token for its API. */
export interface DxFakeConfig {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

class DxClient {
  constructor(private readonly cfg: DxFakeConfig) {}

  async call<T>(method: "GET" | "POST", path: string, schema: z.ZodType<T>, body: unknown): Promise<T> {
    const f = this.cfg.fetch ?? fetch;
    const res = await f(new URL(path, this.cfg.baseUrl), {
      method,
      headers: { authorization: `Bearer ${this.cfg.token}`, "content-type": "application/json" },
      body: body === null ? null : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`fake DX ${method} ${path} failed with ${res.status}: ${text.slice(0, 300)}`);
    return schema.parse(JSON.parse(text));
  }
}

/**
 * MetricsSink that writes one row per task into the fake DX `custom.factory_tasks`
 * table with a SQL upsert, the way a real DX custom-tables integration would.
 */
export class DxFakeSink implements MetricsSink {
  readonly name = "dxfake";
  private readonly client: DxClient;

  constructor(cfg: DxFakeConfig) {
    this.client = new DxClient(cfg);
  }

  async writeTasks(records: TaskRecord[]): Promise<void> {
    if (records.length === 0) return;
    const params: Cell[] = [];
    const tuples = records.map((r) => {
      const row = taskRow(r);
      const placeholders = COLUMNS.map((c) => {
        params.push(row[c]);
        return `$${params.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    const sql = `INSERT INTO custom.${FACTORY_TASKS_TABLE} (${COLUMNS.join(", ")}) VALUES ${tuples.join(", ")} ON CONFLICT (task_id) DO UPDATE`;
    await this.client.call("POST", "/api/sql", z.object({ ok: z.literal(true) }), { sql, params });
  }
}

/**
 * Reads deployments and incidents back out of the fake DX and attributes them to merged tasks:
 * - an incident linked to the task's PR, or to its merge sha, becomes `incident_linked`;
 * - a successful deploy of the merge sha becomes `deployed` (one per environment), so the timeline
 *   shows when the change reached people, and lead time to deploy can be scored.
 */
export class DxFakeOutcomeSource implements OutcomeSource {
  readonly name = "dxfake";
  private readonly client: DxClient;

  constructor(cfg: DxFakeConfig) {
    this.client = new DxClient(cfg);
  }

  async deployments(): Promise<Deployment[]> {
    const r = await this.client.call("GET", "/api/deployments.list", z.object({ deployments: z.array(Deployment) }), null);
    return r.deployments;
  }

  async incidents(): Promise<Incident[]> {
    const r = await this.client.call("GET", "/api/incidents.list", z.object({ incidents: z.array(Incident) }), null);
    return r.incidents;
  }

  async poll(merged: MergedTask[], now: string): Promise<FoundOutcome[]> {
    const withPr = merged.filter((t) => t.record.pr !== null);
    if (withPr.length === 0) return [];
    const [incidents, deployments] = await Promise.all([this.incidents(), this.deployments()]);
    const out: FoundOutcome[] = [];
    for (const t of withPr) {
      const repo = `${t.record.source.repo.owner}/${t.record.source.repo.name}`;
      const ref = `${repo}#${t.record.pr!.number}`;
      const sha = t.mergeSha;
      const bySha = (s: string) => sha !== null && (s === sha || (s.length >= 7 && sha.startsWith(s)) || (sha.length >= 7 && s.startsWith(sha)));
      for (const i of incidents) {
        if (!i.linkedPrs.includes(ref) && !i.commitShas.some(bySha)) continue;
        out.push({
          taskId: t.record.id,
          ref: `incident:${i.id}`,
          outcome: { kind: "incident_linked", source: this.name, detail: `incident ${i.id} (${i.severity}): ${i.title}`, at: i.startedAt, arrivedAt: now },
        });
      }
      const firstPerEnv = new Map<string, Deployment>();
      for (const d of deployments) {
        if (!d.success || d.repo !== repo || !bySha(d.commitSha)) continue;
        const seen = firstPerEnv.get(d.environment);
        if (!seen || d.deployedAt < seen.deployedAt) firstPerEnv.set(d.environment, d);
      }
      for (const d of firstPerEnv.values()) {
        out.push({
          taskId: t.record.id,
          ref: `deploy:${d.environment}`,
          outcome: { kind: "deployed", source: this.name, detail: `deployed to ${d.environment} (${d.service}, deploy ${d.id})`, at: d.deployedAt, arrivedAt: now },
        });
      }
    }
    return out;
  }

  /** Outcomes for one task not already on the record (deduplicated by kind + detail). */
  async outcomesFor(record: TaskRecord, now: string): Promise<Outcome[]> {
    const m = mergeOf(record) ?? { record, mergeSha: null, mergedAt: record.updatedAt };
    const known = new Set(record.outcomes.map((o) => `${o.kind}|${o.detail}`));
    return (await this.poll([m], now)).map((f) => f.outcome).filter((o) => !known.has(`${o.kind}|${o.detail}`));
  }
}
