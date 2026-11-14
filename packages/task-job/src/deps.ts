import type {
  AgentHarness,
  WorldCheck,
  Chat,
  CodeForge,
  Environment,
  MetricsSink,
  RepoRef,
  Scorer,
  TaskRecord,
  Workspace,
  VersionBundle,
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
  /** Run the product forward in a simulated world against each settled PR head (optional; slow, runs in the background). */
  world?: { check: WorldCheck; world: string; simDays: number } | null;
  /** Per team factory: its world (null: none) and merge-risk rules. Missing: the org defaults above. */
  factories?: Record<string, { world?: { world: string; simDays: number } | null; risk?: RiskConfig }>;
  sinks: MetricsSink[];
  /** Start-up checks (model access, code-host access). A failing one stops the task before any environment is made. */
  preflight?: (task: TaskRecord) => Promise<Array<{ name: string; ok: boolean; detail: string; fix: string | null }>>;
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
    /** What each factory version gives the agent: skills, AGENTS.md guidance, MCP tools, effort, CodeGraph. */
    versionBundles?: Record<string, VersionBundle>;
    /** Delays before each automatic retry of a passing failure (network, 429, 5xx). Default 5 s, 30 s, 2 min. */
    retryDelaysMs?: number[];
  };
  log: Log;
};

export function branchFor(deps: JobDeps, record: TaskRecord): string {
  return `${deps.config.branchPrefix}${record.id}`;
}

export function issueTarget(record: TaskRecord): { repo: RepoRef; issueOrPr: number } | null {
  return record.source.issueNumber === null ? null : { repo: record.source.repo, issueOrPr: record.source.issueNumber };
}
