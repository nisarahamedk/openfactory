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
   * Where Claude Code keeps its config and session transcripts. Put it on the
   * workspace's persistent disk so a woken workspace can resume the session.
   */
  configDir: string;
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
      CLAUDE_CONFIG_DIR: options.configDir,
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
