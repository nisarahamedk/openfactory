import { z } from "zod";
import { TaskStatus, type LedgerEvent } from "@openfactory/contracts";

/**
 * Typed views of the ledger events scorers read. LedgerEvent.data is untyped in the
 * contract, so each kind is parsed here, at the scoring boundary. Events that don't
 * parse are ignored (a scorer then returns null rather than guessing).
 */
const StatusChanged = z.object({ from: TaskStatus.nullable().catch(null), to: TaskStatus });
const CiCompleted = z.object({
  headSha: z.string(),
  conclusion: z.string(),
  name: z.string().catch("ci"),
});
const PrOpened = z.object({ number: z.number().int(), headSha: z.string().nullable().catch(null) });
const Pushed = z.object({ sha: z.string() });
const TurnFinished = z.object({ reason: z.enum(["intake", "review", "steer"]).catch("intake") });

export type StatusChange = { at: string; from: TaskStatus | null; to: TaskStatus };
export type CiRun = { at: string; headSha: string; conclusion: string; name: string };
export type Push = { at: string; sha: string };
export type Turn = { at: string; reason: "intake" | "review" | "steer" };

/** Events sorted by time and parsed into the kinds scorers care about. */
export interface ParsedEvents {
  statusChanges: StatusChange[];
  ciRuns: CiRun[];
  prOpened: { at: string; number: number; headSha: string | null } | null;
  pushes: Push[];
  turns: Turn[];
}

/** Parse a task's event log. Order in the result follows `at`, oldest first. */
export function parseEvents(events: LedgerEvent[]): ParsedEvents {
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const out: ParsedEvents = { statusChanges: [], ciRuns: [], prOpened: null, pushes: [], turns: [] };
  for (const e of sorted) {
    switch (e.type) {
      case "status_changed": {
        const r = StatusChanged.safeParse(e.data);
        if (r.success) out.statusChanges.push({ at: e.at, ...r.data });
        break;
      }
      case "ci_completed": {
        const r = CiCompleted.safeParse(e.data);
        if (r.success) out.ciRuns.push({ at: e.at, ...r.data });
        break;
      }
      case "pr_opened": {
        const r = PrOpened.safeParse(e.data);
        if (r.success && out.prOpened === null) out.prOpened = { at: e.at, ...r.data };
        break;
      }
      case "pushed": {
        const r = Pushed.safeParse(e.data);
        if (r.success) out.pushes.push({ at: e.at, ...r.data });
        break;
      }
      case "turn_finished": {
        const r = TurnFinished.safeParse(e.data);
        if (r.success) out.turns.push({ at: e.at, ...r.data });
        break;
      }
      default:
        break;
    }
  }
  return out;
}
