import { afterEach, describe, expect, it } from "vitest";
import { TurnResult, type AgentHarness, type AgentSession, type AgentUpdate, type WorkspaceHandle } from "@openfactory/contracts";
import type { Subject } from "../harness.js";

/**
 * An AgentHarness under test, with a workspace to run in. The model behind it
 * must answer every turn with `conformanceReply(everything it was shown)`, so
 * the suite can tell what reached the model: a mock model in the provider's
 * own tests, never a paid one.
 */
export interface AgentHarnessSubject extends Subject<AgentHarness> {
  workspace: WorkspaceHandle;
  cwd: string;
  /** Extra env for the agent process (model proxy URL, key). */
  env?: Record<string, string>;
}

export interface AgentHarnessConformanceOptions {
  /** Per-test timeout; real agents start slowly. */
  timeoutMs?: number;
}

const TOKEN = /cf-tok-[a-z0-9]+/g;

/** What the conformance model says: every probe token it was shown, in first-seen order. */
export function conformanceReply(shown: string): string {
  const seen = [...new Set(shown.match(TOKEN) ?? [])];
  return seen.length === 0 ? "seen: none" : `seen: ${seen.join(" ")}`;
}

let seq = 0;
const token = () => `cf-tok-${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * Conformance for an AgentHarness: a session has an id, a turn streams
 * updates and ends with a TurnResult, the system prompt and the prompt reach
 * the model, and a later round resumes the SAME session with its history.
 */
export function describeAgentHarnessConformance(
  label: string,
  make: () => Promise<AgentHarnessSubject>,
  options: AgentHarnessConformanceOptions = {},
): void {
  const timeout = options.timeoutMs ?? 180_000;
  describe(`AgentHarness conformance: ${label}`, () => {
    let current: { s: AgentHarnessSubject; sessions: AgentSession[] } | null = null;
    const subject = async () => {
      if (current === null) current = { s: await make(), sessions: [] };
      return current;
    };
    const open = async (input: { systemPrompt?: string; resume?: string | null } = {}) => {
      const c = await subject();
      const session = await c.s.subject.openSession({
        workspace: c.s.workspace,
        cwd: c.s.cwd,
        systemPrompt: input.systemPrompt ?? "You are under a conformance test.",
        resumeSessionId: input.resume ?? null,
        ...(c.s.env === undefined ? {} : { env: c.s.env }),
      });
      c.sessions.push(session);
      return session;
    };
    const turn = async (session: AgentSession, text: string) => {
      const updates: AgentUpdate[] = [];
      const result = await session.prompt(text, (u) => updates.push(u));
      return { result: TurnResult.parse(result), updates };
    };
    afterEach(async () => {
      if (current === null) return;
      for (const s of current.sessions) await s.close().catch(() => undefined);
      await current.s.cleanup();
      current = null;
    });

    it("names itself and its model", async () => {
      const { s } = await subject();
      expect(s.subject.name).toMatch(/\S/);
      expect(s.subject.model).toMatch(/\S/);
    });

    it("a turn reaches the model, streams updates and ends with a TurnResult", { timeout }, async () => {
      const sys = token();
      const ask = token();
      const session = await open({ systemPrompt: `Rules for this task. Probe ${sys}.` });
      expect(session.sessionId).toMatch(/\S/);
      const { result, updates } = await turn(session, `Probe ${ask}. Say which probes you have seen.`);
      expect(result.stopReason).toBe("end_turn");
      expect(result.summary).toContain(ask);
      expect(result.summary, "the system prompt reached the model").toContain(sys);
      expect(result.usage.costUsd).toBeGreaterThanOrEqual(0);
      expect(updates.some((u) => u.kind === "message")).toBe(true);
    });

    it("two sessions are separate", { timeout }, async () => {
      const a = await open();
      const b = await open();
      expect(b.sessionId).not.toBe(a.sessionId);
      const first = token();
      await turn(a, `Probe ${first}.`);
      const { result } = await turn(b, `Probe ${token()}.`);
      expect(result.summary).not.toContain(first);
    });

    it("a later round resumes the same session with its history", { timeout }, async () => {
      const round1 = token();
      const session = await open();
      await turn(session, `Round one. Probe ${round1}.`);
      const id = session.sessionId;
      await session.close();

      const round2 = token();
      const resumed = await open({ resume: id });
      expect(resumed.sessionId).toBe(id);
      const { result } = await turn(resumed, `Round two. Probe ${round2}. Which probes have you seen?`);
      expect(result.summary).toContain(round1);
      expect(result.summary).toContain(round2);
    });

    it("refuses a second prompt while a turn is running", { timeout }, async () => {
      const session = await open();
      const first = session.prompt(`Probe ${token()}.`, () => undefined);
      await expect(session.prompt("again", () => undefined)).rejects.toThrow();
      TurnResult.parse(await first);
    });

    it("cancel when idle is harmless, and the session still works", { timeout }, async () => {
      const session = await open();
      await session.cancel();
      const probe = token();
      const { result } = await turn(session, `Probe ${probe}.`);
      expect(result.summary).toContain(probe);
    });
  });
}
