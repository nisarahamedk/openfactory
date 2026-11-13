import { describe, expect, it } from "vitest";
import { Score, type Scorer } from "@openfactory/contracts";
import { deepFreeze, standardCases } from "../fixtures.js";

const NOW = "2026-11-13T12:00:00.000Z";

/**
 * Conformance for a Scorer. Every scorer must, for every standard case:
 *  - return null or a valid Score stamped with its own name, version and `now`;
 *  - never throw, even on malformed events;
 *  - be deterministic and independent of event order;
 *  - not mutate its inputs.
 */
export function describeScorerConformance(label: string, make: () => Scorer): void {
  describe(`Scorer conformance: ${label}`, () => {
    it("has a non-empty name and version", () => {
      const s = make();
      expect(s.name).toMatch(/\S/);
      expect(s.version).toMatch(/\S/);
    });

    for (const c of standardCases()) {
      it(`${c.label}: returns null or a valid, self-stamped score`, () => {
        const s = make();
        const out = s.score(deepFreeze(structuredClone(c.record)), deepFreeze(structuredClone(c.events)), NOW);
        if (out === null) return;
        expect(Score.parse(out)).toEqual(out);
        expect(out.scorer).toBe(s.name);
        expect(out.scorerVersion).toBe(s.version);
        expect(out.at).toBe(NOW);
        expect(Number.isFinite(out.value)).toBe(true);
      });

      it(`${c.label}: deterministic and independent of event order`, () => {
        const s = make();
        const a = s.score(structuredClone(c.record), structuredClone(c.events), NOW);
        const b = s.score(structuredClone(c.record), structuredClone(c.events), NOW);
        const reversed = s.score(structuredClone(c.record), structuredClone(c.events).reverse(), NOW);
        expect(b).toEqual(a);
        expect(reversed).toEqual(a);
      });
    }
  });
}
