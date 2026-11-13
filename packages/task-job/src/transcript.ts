/**
 * One turn's AgentUpdate stream as JSONL: the factory's own copy of what the
 * agent did, kept in the EvidenceStore so scorers and the dashboard never
 * depend on a harness's session format. Message chunks are joined into one
 * line per message; identical consecutive updates are dropped.
 */
import type { AgentUpdate } from "@openfactory/contracts";

export type TranscriptLine =
  | { at: string; kind: "prompt"; text: string }
  | ({ at: string } & AgentUpdate)
  | { at: string; kind: "result"; stopReason: string; usage: unknown }
  | { at: string; kind: "error"; message: string };

const MAX_LINES = 20_000;
const MAX_TEXT = 200_000;

export class TranscriptRecorder {
  private readonly lines: TranscriptLine[] = [];
  private dropped = 0;

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  prompt(text: string): void {
    this.push({ at: this.now(), kind: "prompt", text: text.slice(0, MAX_TEXT) });
  }

  update(u: AgentUpdate): void {
    const last = this.lines.at(-1);
    if (u.kind === "message" && last?.kind === "message") {
      if (last.text.length < MAX_TEXT) last.text += u.text;
      return;
    }
    if (last && last.kind === u.kind && JSON.stringify({ ...last, at: "" }) === JSON.stringify({ ...u, at: "" })) return;
    this.push({ at: this.now(), ...u } as TranscriptLine);
  }

  result(stopReason: string, usage: unknown): void {
    this.push({ at: this.now(), kind: "result", stopReason, usage });
  }

  error(message: string): void {
    this.push({ at: this.now(), kind: "error", message: message.slice(0, 4000) });
  }

  get size(): number {
    return this.lines.length;
  }

  toJsonl(): string {
    const tail = this.dropped ? [JSON.stringify({ at: this.now(), kind: "error", message: `${this.dropped} lines dropped (limit ${MAX_LINES})` })] : [];
    return [...this.lines.map((l) => JSON.stringify(l)), ...tail].join("\n") + "\n";
  }

  private push(l: TranscriptLine): void {
    if (this.lines.length >= MAX_LINES) {
      this.dropped++;
      return;
    }
    this.lines.push(l);
  }
}
