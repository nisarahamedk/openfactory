import type { AgentHarness, AgentSession, AgentUpdate, TurnResult, WorkspaceHandle } from "@openfactory/contracts";
import { conformanceReply } from "./suite.js";

/** The model a fake turn calls: what the agent was shown in, reply text out. */
export type FakeModel = (shown: string) => string;

/**
 * An AgentHarness with no real agent. Like a real one, its transcript lives on
 * the workspace's disk (inside .git, so the checkout stays clean), so a later
 * round can resume the session from a fresh process. The default model is the
 * conformance model.
 */
export class ScriptedAgentHarness implements AgentHarness {
  readonly name = "scripted-fake";
  constructor(
    readonly model = "conformance-model",
    private readonly reply: FakeModel = conformanceReply,
  ) {}

  async openSession(input: {
    workspace: WorkspaceHandle;
    cwd: string;
    systemPrompt: string;
    resumeSessionId: string | null;
    env?: Record<string, string>;
  }): Promise<AgentSession> {
    const id = input.resumeSessionId ?? `fake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const path = `${input.workspace.repoPath}/.git/fake-agent/${id}.json`;
    let history: string[] = [];
    if (input.resumeSessionId !== null) {
      const read = await input.workspace.exec(["cat", path]);
      if (read.exitCode !== 0) throw new Error(`No session ${id} in this workspace`);
      history = JSON.parse(read.stdout) as string[];
    }
    return new ScriptedSession(id, input.workspace, path, input.systemPrompt, history, this.reply);
  }
}

class ScriptedSession implements AgentSession {
  private busy = false;
  private closed = false;

  constructor(
    readonly sessionId: string,
    private readonly workspace: WorkspaceHandle,
    private readonly path: string,
    private readonly systemPrompt: string,
    private readonly history: string[],
    private readonly reply: FakeModel,
  ) {}

  async prompt(text: string, onUpdate: (u: AgentUpdate) => void): Promise<TurnResult> {
    if (this.closed) throw new Error("Session is closed");
    if (this.busy) throw new Error("A turn is already running on this session");
    this.busy = true;
    try {
      this.history.push(text);
      onUpdate({ kind: "tool_call", title: "Read history", status: "completed" });
      const answer = this.reply([this.systemPrompt, ...this.history].join("\n"));
      this.history.push(answer);
      await this.workspace.writeFile(this.path, JSON.stringify(this.history));
      onUpdate({ kind: "message", text: answer });
      return { stopReason: "end_turn", summary: answer, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
    } finally {
      this.busy = false;
    }
  }

  async cancel(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
  }
}
