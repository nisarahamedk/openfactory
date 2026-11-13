/**
 * Teams and factories, from factory.yaml:
 *
 *   teams:                                   # a list (no directory), or one directory provider:
 *     - { slug: core, name: Core, members: [dana, li], repos: [acme/app], factory: default }
 *   # teams: { github: { org: acme, factories: { payments: payments } } }
 *
 *   factories:                               # the org default is implicit; team factories build on it
 *     payments:
 *       extends: default
 *       description: Money rules reviewer and ledger checks
 *       scorers: [ledger-balances]
 *       benchmarks: [payments-core]
 *       world: payments-30d                  # OpenWorld world for the 30-day check, if any
 *       mergeRisk: { high: [migrations/**, src/payments/**], low: [docs/**, "**\/*.md"] }
 *
 * A team factory lists only what it changes. Org scorers always apply; a team factory can add scorers,
 * never remove one.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Directory, Team } from "@openfactory/contracts";
import type { FactoryView } from "@openfactory/client";
import { parse } from "yaml";
import { z } from "zod";

const TeamInput = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().optional(),
  members: z.array(z.union([z.string(), z.object({ login: z.string(), name: z.string().optional(), role: z.enum(["member", "maintainer"]).optional() })])).default([]),
  repos: z.array(z.string()).default([]),
  factory: z.string().default("default"),
});

export const FactoryDef = z
  .object({
    extends: z.string().default("default"),
    description: z.string().optional(),
    scorers: z.array(z.string()).default([]),
    benchmarks: z.array(z.string()).default([]),
    world: z.string().optional(),
    mergeRisk: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type FactoryDef = z.infer<typeof FactoryDef>;

const OrgFile = z
  .object({
    teams: z.union([z.array(TeamInput), z.record(z.string(), z.record(z.string(), z.unknown()))]).optional(),
    factories: z.record(z.string(), FactoryDef).default({}),
  })
  .passthrough();

export type OrgConfig = {
  /** Teams written in factory.yaml, or null when a directory provider is named. */
  teams: Team[] | null;
  /** The directory provider to build (e.g. github with { org }), when `teams:` names one. */
  directory: { name: string; options: Record<string, unknown> } | null;
  factories: Record<string, FactoryDef>;
};

export function parseOrgConfig(text: string): OrgConfig {
  const doc = OrgFile.parse(parse(text) ?? {});
  let teams: Team[] | null = null;
  let directory: OrgConfig["directory"] = null;
  if (Array.isArray(doc.teams)) {
    teams = doc.teams.map((t) => ({
      slug: t.slug,
      name: t.name ?? t.slug,
      source: "config",
      members: t.members.map((m) => (typeof m === "string" ? { login: m, name: null, role: "member" as const } : { login: m.login, name: m.name ?? null, role: m.role ?? "member" })),
      repos: t.repos,
      factory: t.factory,
    }));
  } else if (doc.teams) {
    const [name, options] = Object.entries(doc.teams)[0] ?? [];
    if (name) directory = { name, options: options ?? {} };
  }
  return { teams, directory, factories: doc.factories };
}

export function loadOrgConfig(path?: string): OrgConfig {
  if (!path || !existsSync(path)) return { teams: null, directory: null, factories: {} };
  return parseOrgConfig(readFileSync(path, "utf8"));
}

/** A directory that holds the teams written in factory.yaml. */
export function configDirectory(teams: Team[]): Directory {
  return { name: "config", teams: async () => teams };
}

/** Directory lookups are slow and rarely change: keep the last answer for `ttlMs`, serve stale on error. */
export function cachedDirectory(inner: Directory, ttlMs = 5 * 60_000, now = () => Date.now()): Directory {
  let hit: { at: number; teams: Team[] } | null = null;
  return {
    name: inner.name,
    async teams() {
      if (hit && now() - hit.at < ttlMs) return hit.teams;
      try {
        hit = { at: now(), teams: await inner.teams() };
      } catch (e) {
        if (!hit) throw e;
      }
      return hit.teams;
    },
  };
}

export function factoryViews(factories: Record<string, FactoryDef>, teams: Team[]): FactoryView[] {
  const teamsOf = (slug: string) => teams.filter((t) => t.factory === slug).map((t) => t.slug);
  const out: FactoryView[] = [
    { slug: "default", extends: null, description: "The org default. Every team factory builds on it.", scorers: [], benchmarks: [], world: null, mergeRisk: null, teams: teamsOf("default") },
  ];
  for (const [slug, f] of Object.entries(factories)) {
    if (slug === "default") {
      Object.assign(out[0]!, { description: f.description ?? out[0]!.description, scorers: f.scorers, benchmarks: f.benchmarks, world: f.world ?? null, mergeRisk: f.mergeRisk ?? null });
      continue;
    }
    out.push({ slug, extends: f.extends, description: f.description ?? null, scorers: f.scorers, benchmarks: f.benchmarks, world: f.world ?? null, mergeRisk: f.mergeRisk ?? null, teams: teamsOf(slug) });
  }
  return out;
}
