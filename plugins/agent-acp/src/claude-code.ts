/**
 * Claude Code as a factory worker, through the ACP adapter
 * `@agentclientprotocol/claude-agent-acp` (it replaced `@zed-industries/claude-agent-acp`).
 */
import { AcpHarness } from "./harness.js";

export interface ClaudeCodeOptions {
  /** e.g. "claude-sonnet-5-5". */
  model: string;
  /** The factory's model proxy (LiteLLM). The sandbox never sees the org's real key. */
  modelProxyUrl: string;
  /** A per-task proxy key with its own budget. */
  modelProxyKey: string;
  /**
   * Where Claude Code keeps its config and session transcripts. It must be on
   * the workspace's persistent disk so a woken workspace can resume the
   * session. null leaves it to the workspace ($HOME/.claude, or the
   * CLAUDE_CONFIG_DIR the workspace sets).
   */
  configDir: string | null;
  /** Command that starts the adapter in the workspace. */
  command?: string[];
  log: (line: string) => void;
}

export function claudeCodeHarness(options: ClaudeCodeOptions): AcpHarness {
  return new AcpHarness({
    name: "claude-code",
    model: options.model,
    command: options.command ?? ["claude-agent-acp"],
    env: {
      ANTHROPIC_BASE_URL: options.modelProxyUrl,
      ANTHROPIC_API_KEY: options.modelProxyKey,
      ANTHROPIC_MODEL: options.model,
      // Claude Code's background calls (titles, summaries) use the small model.
      ANTHROPIC_SMALL_FAST_MODEL: options.model,
      CLAUDE_CODE_SUBAGENT_MODEL: options.model,
      ...(options.configDir === null ? {} : { CLAUDE_CONFIG_DIR: options.configDir }),
      // The workspace is the sandbox; this lets bypassPermissions run as root.
      IS_SANDBOX: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
    },
    modeId: "bypassPermissions",
    log: options.log,
  });
}

/** Factory used by apps/server to wire the worker from settings. */
export const createAcpHarness = claudeCodeHarness;

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key];
  if (value === undefined || value === "") throw new Error(`agent-acp needs ${key}`);
  return value;
}

/**
 * Builds the worker harness from settings. See README.md for the variables.
 * Only Claude Code is wired today; other ACP agents (Codex, Copilot CLI) use
 * AcpHarness directly with their own command and env.
 */
export function fromEnv(env: Env): AcpHarness {
  const agent = env.ACP_AGENT ?? "claude-code";
  if (agent !== "claude-code") throw new Error(`agent-acp: unknown ACP_AGENT "${agent}" (known: claude-code)`);
  const command = env.ACP_AGENT_COMMAND;
  return claudeCodeHarness({
    model: required(env, "WORKER_MODEL"),
    modelProxyUrl: required(env, "MODEL_PROXY_URL"),
    modelProxyKey: required(env, "MODEL_PROXY_KEY"),
    configDir: env.ACP_CONFIG_DIR ?? null,
    ...(command === undefined || command === "" ? {} : { command: command.split(" ") }),
    log: (line) => {
      if (env.ACP_DEBUG === "1") process.stderr.write(`[agent-acp] ${line}\n`);
    },
  });
}
