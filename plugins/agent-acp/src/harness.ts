/**
 * An `AgentHarness` that drives any ACP agent running inside a workspace.
 *
 * The agent process runs in the workspace (where its tools are), and we talk to
 * it over its stdio. Its session transcript lives on the workspace's disk, so a
 * later review round starts a fresh process and resumes the SAME session id.
 */
import { z } from "zod";
import type {
  Effort,
  McpServer,
  AgentHarness,
  AgentSession,
  AgentUpdate,
  TurnResult,
  WorkspaceHandle,
} from "@openfactory/contracts";
import { JsonRpcPeer } from "./jsonrpc.js";

/** How to start one ACP agent inside the workspace. */
export interface AcpAgentSpec {
  /** Harness name recorded in the ledger, e.g. "claude-code". */
  name: string;
  /** Model recorded in the ledger and passed to the agent through `env`. */
  model: string;
  /** Command that starts the ACP agent on stdio, e.g. ["claude-agent-acp"]. */
  command: string[];
  /** Environment for the agent process (model proxy URL, task key, model). */
  env: Record<string, string>;
  /** Env vars that select a model for one session (model routing). Without it, a per-task model is ignored. */
  modelEnv?: (model: string) => Record<string, string>;
  /** Session mode to switch to after open; null keeps the agent's default. */
  modeId: string | null;
  /** Called with stdout lines that are not ACP messages, and with stderr. */
  log: (line: string) => void;
}

const InitializeResult = z.object({
  protocolVersion: z.number(),
  agentCapabilities: z
    .object({
      loadSession: z.boolean().optional(),
      sessionCapabilities: z.object({ resume: z.object({}).passthrough().optional() }).passthrough().optional(),
    })
    .passthrough(),
});

const NewSessionResult = z.object({ sessionId: z.string() }).passthrough();

const Count = z.number().nonnegative().catch(0).default(0);
const PromptResult = z.object({
  stopReason: z.enum(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]),
  /** ACP prompt usage (the turn's tokens); cache reads and writes count as input. */
  usage: z.object({ inputTokens: Count, outputTokens: Count, cachedReadTokens: Count, cachedWriteTokens: Count }).nullish(),
});

const PermissionRequest = z.object({
  sessionId: z.string(),
  options: z.array(z.object({ optionId: z.string(), kind: z.string() })),
});

const SessionNotification = z.object({
  sessionId: z.string(),
  update: z.object({ sessionUpdate: z.string() }).passthrough(),
});

const ToolStatus = z.enum(["pending", "in_progress", "completed", "failed"]);

const MessageChunk = z.object({ content: z.object({ type: z.string(), text: z.string().optional() }) });
const ToolCall = z.object({ toolCallId: z.string(), title: z.string().optional(), status: ToolStatus.optional() });
const Plan = z.object({ entries: z.array(z.object({ content: z.string() })) });
const UsageUpdate = z.object({
  used: z.number().optional(),
  cost: z.object({ amount: z.number(), currency: z.string() }).optional(),
});

/** Opens ACP sessions for one agent kind (Claude Code, Codex, Copilot CLI...). */
export class AcpHarness implements AgentHarness {
  readonly name: string;
  readonly model: string;

  constructor(private readonly spec: AcpAgentSpec) {
    this.name = spec.name;
    this.model = spec.model;
  }

  async openSession(input: {
    workspace: WorkspaceHandle;
    cwd: string;
    systemPrompt: string;
    resumeSessionId: string | null;
    env?: Record<string, string>;
    model?: string;
    mcpServers?: McpServer[];
    effort?: Effort;
  }): Promise<AgentSession> {
    // The task's env (per-task proxy key, git token) and model win over the harness defaults.
    const modelEnv = input.model && input.model !== this.model && this.spec.modelEnv ? this.spec.modelEnv(input.model) : {};
    const proc = await input.workspace.spawn(this.spec.command, { cwd: input.cwd, env: { ...this.spec.env, ...modelEnv, ...input.env } });
    const peer = new JsonRpcPeer(proc.stdin, proc.stdout, this.spec.log);
    const session = new AcpSession(peer, proc, this.spec);
    peer.start();
    await session.open(input.cwd, input.systemPrompt, input.resumeSessionId, input.mcpServers ?? [], input.effort ?? null);
    return session;
  }
}

/** The agent cannot continue an earlier session (no resume or load support). */
export class SessionNotResumable extends Error {
  readonly code = "session_not_resumable" as const;
  constructor(readonly sessionId: string) {
    super(`The agent cannot resume session ${sessionId}: it offers neither session/resume nor session/load`);
  }
}

interface TurnState {
  onUpdate: (u: AgentUpdate) => void;
  text: string[];
  costUsd: number;
  toolTitles: Map<string, string>;
}

class AcpSession implements AgentSession {
  private id: string | null = null;
  private turn: TurnState | null = null;
  /** Cumulative cost the agent last reported in this process. */
  private lastCumulativeCost = 0;
  /** While loading a session the agent replays history; we drop those updates. */
  private replaying = false;

  constructor(
    private readonly peer: JsonRpcPeer,
    private readonly proc: { exited: Promise<number>; kill(): Promise<void> },
    private readonly spec: AcpAgentSpec,
  ) {
    peer.onNotification("session/update", (params) => this.onSessionUpdate(params));
    peer.onRequest("session/request_permission", async (params) => this.choosePermission(params));
  }

  get sessionId(): string {
    if (this.id === null) throw new Error("ACP session used before it was opened");
    return this.id;
  }

  async open(cwd: string, systemPrompt: string, resumeSessionId: string | null, mcp: McpServer[] = [], effort: Effort | null = null): Promise<void> {
    const init = InitializeResult.parse(
      await this.peer.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "openfactory", version: "0.0.1" },
      }),
    );
    const prompt = { mode: "append", content: [{ type: "text", text: systemPrompt }] };
    // ACP McpServerStdio; env as name/value pairs. Effort through the Claude Code adapter's session options.
    const mcpServers = mcp.map((m) => ({ name: m.name, command: m.command, args: m.args, env: Object.entries(m.env).map(([name, value]) => ({ name, value })) }));
    const extra = effort ? { _meta: { claudeCode: { options: { effort } } } } : {};
    if (resumeSessionId === null) {
      const created = NewSessionResult.parse(
        await this.peer.request("session/new", { cwd, mcpServers, systemPrompt: prompt, ...extra }),
      );
      this.id = created.sessionId;
    } else if (init.agentCapabilities.sessionCapabilities?.resume !== undefined) {
      await this.peer.request("session/resume", { sessionId: resumeSessionId, cwd, mcpServers, systemPrompt: prompt, ...extra });
      this.id = resumeSessionId;
    } else if (init.agentCapabilities.loadSession === true) {
      this.replaying = true;
      await this.peer.request("session/load", { sessionId: resumeSessionId, cwd, mcpServers, systemPrompt: prompt, ...extra });
      this.replaying = false;
      this.id = resumeSessionId;
    } else {
      throw new SessionNotResumable(resumeSessionId);
    }
    if (this.spec.modeId !== null) {
      await this.peer.request("session/set_mode", { sessionId: this.sessionId, modeId: this.spec.modeId });
    }
  }

  async prompt(text: string, onUpdate: (u: AgentUpdate) => void): Promise<TurnResult> {
    if (this.turn !== null) throw new Error("A turn is already running on this session");
    const turn: TurnState = { onUpdate, text: [], costUsd: 0, toolTitles: new Map() };
    this.turn = turn;
    try {
      const raw = await Promise.race([
        this.peer.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] }),
        this.proc.exited.then((code) => {
          throw new Error(`The agent process exited with code ${code} during the turn`);
        }),
      ]);
      const result = PromptResult.parse(raw);
      return {
        stopReason: result.stopReason === "max_turn_requests" ? "max_tokens" : result.stopReason,
        summary: turn.text.join(""),
        usage: {
          inputTokens: result.usage ? result.usage.inputTokens + result.usage.cachedReadTokens + result.usage.cachedWriteTokens : 0,
          outputTokens: result.usage?.outputTokens ?? 0,
          // The agent's own estimate; the task job replaces it with the model gateway's spend when it has one.
          costUsd: turn.costUsd,
        },
      };
    } finally {
      this.turn = null;
    }
  }

  async cancel(): Promise<void> {
    await this.peer.notify("session/cancel", { sessionId: this.sessionId });
  }

  async close(): Promise<void> {
    await this.peer.close();
    await this.proc.kill();
  }

  private choosePermission(params: unknown): unknown {
    // The workspace is the sandbox: the agent may do anything inside it. What it
    // may do outside (push, deploy) is bounded by the credentials it was given.
    const request = PermissionRequest.parse(params);
    const allow =
      request.options.find((o) => o.kind === "allow_always") ?? request.options.find((o) => o.kind === "allow_once");
    if (allow === undefined) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: allow.optionId } };
  }

  private onSessionUpdate(params: unknown): void {
    const parsed = SessionNotification.safeParse(params);
    if (!parsed.success || this.replaying) return;
    const turn = this.turn;
    if (turn === null) return;
    const update = parsed.data.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const chunk = MessageChunk.safeParse(update);
        if (chunk.success && chunk.data.content.text !== undefined) {
          turn.text.push(chunk.data.content.text);
          turn.onUpdate({ kind: "message", text: chunk.data.content.text });
        }
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const call = ToolCall.safeParse(update);
        if (!call.success) return;
        if (call.data.title !== undefined) turn.toolTitles.set(call.data.toolCallId, call.data.title);
        turn.onUpdate({
          kind: "tool_call",
          title: turn.toolTitles.get(call.data.toolCallId) ?? call.data.toolCallId,
          status: call.data.status ?? "pending",
        });
        return;
      }
      case "plan": {
        const plan = Plan.safeParse(update);
        if (plan.success) turn.onUpdate({ kind: "plan", entries: plan.data.entries.map((e) => e.content) });
        return;
      }
      case "usage_update": {
        const usage = UsageUpdate.safeParse(update);
        if (!usage.success || usage.data.cost === undefined) return;
        const cumulative = usage.data.cost.amount;
        // The agent reports cost summed over its process; a smaller number means it restarted its count.
        const delta = cumulative >= this.lastCumulativeCost ? cumulative - this.lastCumulativeCost : cumulative;
        this.lastCumulativeCost = cumulative;
        turn.costUsd += delta;
        return;
      }
      default:
        return;
    }
  }
}
