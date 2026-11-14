/**
 * The layer rules (the-stack coding-standards §1), checked on every test run:
 *   domain       imports only zod, the contracts and other domain files: no I/O.
 *   ports        imports only the contracts (it is interfaces).
 *   application  imports domain, ports and the contracts: never a database, HTTP, a vendor or a plugin.
 * Adapters and wiring live in apps/server.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

const SRC = join(import.meta.dirname, ".");
const SHARED = ["zod", "@openfactory/contracts", "@openfactory/contract"];
const ALLOWED: Record<string, { packages: string[]; layers: string[] }> = {
  domain: { packages: SHARED, layers: ["domain"] },
  ports: { packages: SHARED, layers: ["ports"] },
  application: { packages: [...SHARED, "@orpc/contract"], layers: ["domain", "ports", "application"] },
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

it("each core layer imports only what it may", () => {
  const broken: string[] = [];
  for (const file of files(SRC)) {
    const layer = relative(SRC, file).split("/")[0] ?? "";
    const rules = ALLOWED[layer];
    if (rules === undefined) continue; // index.ts re-exports
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:import|export)\s[^"']*?from\s+["']([^"']+)["']|import\(["']([^"']+)["']\)/g)) {
      const spec = m[1] ?? m[2] ?? "";
      if (spec.startsWith(".")) {
        const target = relative(SRC, join(file, "..", spec)).split("/")[0] ?? "";
        if (!rules.layers.includes(target)) broken.push(`${relative(SRC, file)} imports ${spec} (${target} layer)`);
      } else if (!rules.packages.some((p) => spec === p || spec.startsWith(`${p}/`))) {
        broken.push(`${relative(SRC, file)} imports ${spec}`);
      }
    }
  }
  expect(broken).toEqual([]);
});
