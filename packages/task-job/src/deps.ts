import type {
  AgentHarness,
  Chat,
  CodeForge,
  Environment,
  MetricsSink,
  RepoRef,
  Scorer,
  TaskRecord,
  Workspace,
} from "@openfactory/contracts";
import type { Ledger } from "@openfactory/ledger";
import type { RiskConfig, RulesConfig } from "@openfactory/rules";

/** Where evidence files copied out of the sandbox are kept and served from. */
export interface EvidenceStore {
  put(taskId: string, name: string, bytes: Uint8Array, contentType: string): Promise<{ url: string }>;
}

/** Per-task model credentials (e.g. a LiteLLM key with the task's budget), revoked when the task ends. */
export interface ModelKeys {
  forTask(taskId: string): Promise<Record<string, string>>;
  revoke(taskId: string): Promise<void>;
  /** What the task's key has spent so far, as the gateway bills it (the ground truth for cost). */
  spend?(taskId: string): Promise<number | null>;
}

export type Log = (msg: string, fields?: Record<string, unknown>) => void;

/** Everything the task job needs; each piece is a plugin chosen at server start. */
export type JobDeps = {
  ledger: Ledger;
  rules: RulesConfig;
  chat: Chat;
  codeForge: CodeForge;
  agent: AgentHarness;
  workspace: Workspace;
  environment: Environment;
  evidence: EvidenceStore;
  modelKeys: ModelKeys | null;
  scorers: Scorer[];
  sinks: MetricsSink[];
  config: {
    baseBranch: string;
    workerImage: string | null;
    /** Extra env for every agent process (model proxy URL, key, model...). */
    agentEnv: Record<string, string>;
    /** Max nudge turns when a turn ends without a PR or evidence. */
    maxNudges: number;
    branchPrefix: string; // "factory/"
    /** Merge-risk rules (paths, size thresholds); null: the defaults. */
    risk?: RiskConfig | null;
    /** Extra system-prompt text per factory version (how a candidate version differs). */
    versionPrompts?: Record<string, string>;
  };
  log: Log;
};

export function branchFor(deps: JobDeps, record: TaskRecord): string {
  return `${deps.config.branchPrefix}${record.id}`;
}

export function issueTarget(record: TaskRecord): { repo: RepoRef; issueOrPr: number } | null {
  return record.source.issueNumber === null ? null : { repo: record.source.repo, issueOrPr: record.source.issueNumber };
}
