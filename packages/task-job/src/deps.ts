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
import type { RulesConfig } from "@openfactory/rules";

/** Where evidence files copied out of the sandbox are kept and served from. */
export interface EvidenceStore {
  put(taskId: string, name: string, bytes: Uint8Array, contentType: string): Promise<{ url: string }>;
}

/** Pushes a branch from a git bundle made in the sandbox, so push credentials never enter the sandbox. */
export interface BranchPusher {
  push(repo: RepoRef, branch: string, bundle: Uint8Array): Promise<void>;
}

/** Per-task model credentials (e.g. a LiteLLM key with the task's budget), revoked when the task ends. */
export interface ModelKeys {
  forTask(taskId: string): Promise<Record<string, string>>;
  revoke(taskId: string): Promise<void>;
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
  pusher: BranchPusher;
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
  };
  log: Log;
};

export function branchFor(deps: JobDeps, record: TaskRecord): string {
  return `${deps.config.branchPrefix}${record.id}`;
}

export function issueTarget(record: TaskRecord): { repo: RepoRef; issueOrPr: number } | null {
  return record.source.issueNumber === null ? null : { repo: record.source.repo, issueOrPr: record.source.issueNumber };
}
