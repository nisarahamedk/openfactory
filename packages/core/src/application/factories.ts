import { personFor } from "../domain/actor.js";
import { errors, fail } from "../domain/errors.js";
import { rolloutChange } from "../domain/rules.js";
import type { CoreDeps } from "../ports/index.js";
import type { Registry } from "./capability.js";
import { allTeams } from "./tasks.js";

async function assertKnownFactory(deps: CoreDeps, slug: string): Promise<void> {
  if (!(await deps.catalog.factories()).some((f) => f.slug === slug)) fail(errors.factoryNotFound(slug));
}

/** The factory itself: health, configuration, team factories and their rollouts, teams. */
export const factoryCapabilities: Pick<Registry, "getHealth" | "getFactory" | "listFactories" | "getRollout" | "setRollout" | "listTeams"> = {
  getHealth: { audience: "viewer", risk: "read", mcp: true, target: null, run: async ({ deps }) => ({ health: await deps.health.report() }) },
  getFactory: { audience: "viewer", risk: "read", mcp: true, target: null, run: async ({ deps }) => ({ factory: await deps.catalog.info() }) },
  listFactories: {
    audience: "viewer",
    risk: "read",
    mcp: true,
    target: null,
    run: async ({ deps }) => {
      const [factories, rollouts] = await Promise.all([deps.catalog.factories(), deps.rollouts.listRollouts()]);
      return { factories, rollouts };
    },
  },
  getRollout: {
    audience: "viewer",
    risk: "read",
    mcp: true,
    target: (i) => `factory:${i.factory}`,
    run: async ({ deps }, i) => {
      await assertKnownFactory(deps, i.factory);
      const r = await deps.rollouts.rollout(i.factory);
      return { rollout: r?.state ?? null, history: r?.history ?? [] };
    },
  },
  // Reversible: the previous version is one call away (roll back). Like a deploy, rollout state lives in the
  // database with its history; the versions themselves are files in the factory repo.
  setRollout: {
    audience: "engineer",
    risk: "reversible",
    mcp: true,
    target: (i) => `factory:${i.factory}`,
    run: async ({ deps, actor }, i) => {
      await assertKnownFactory(deps, i.factory);
      const state = rolloutChange(i.factory, { live: i.live, candidate: i.candidate, share: i.share, note: i.note }, personFor(actor, i.by));
      const rollout = await deps.rollouts.setRollout(state);
      deps.log("rollout changed", { ...rollout });
      return { rollout };
    },
  },
  listTeams: { audience: "viewer", risk: "read", mcp: true, target: null, run: async ({ deps }) => ({ teams: await allTeams(deps) }) },
};

/** Saved views: a name plus an app path. Anyone with the id may open one; only its owner changes it. */
export const viewCapabilities: Pick<Registry, "listViews" | "getView" | "saveView" | "deleteView"> = {
  listViews: {
    audience: "viewer",
    risk: "read",
    mcp: true,
    target: null,
    run: async ({ deps, actor }, i) => {
      const viewer = personFor(actor, i.viewer).toLowerCase();
      const teams = (await allTeams(deps)).filter((t) => t.members.some((m) => m.login.toLowerCase() === viewer)).map((t) => t.slug);
      return { views: await deps.views.listViews({ login: viewer, teams }) };
    },
  },
  getView: { audience: "viewer", risk: "read", mcp: true, target: (i) => `view:${i.id}`, run: async ({ deps }, i) => ({ view: (await deps.views.getView(i.id)) ?? fail(errors.viewNotFound(i.id)) }) },
  saveView: {
    audience: "viewer",
    risk: "reversible",
    mcp: true,
    target: (i) => (i.id ? `view:${i.id}` : null),
    run: async ({ deps, actor }, i) => {
      if (i.share === "team" && !i.team) fail(errors.invalid("A team view needs a team. Name the team, or share it with yourself or the org.", [{ path: "team", message: "required when share is team" }]));
      const owner = personFor(actor, i.owner);
      const base = { name: i.name, path: i.path, owner, share: i.share, team: i.team };
      return { view: await deps.views.saveView(i.id ? { id: i.id, ...base } : base) };
    },
  },
  // Irreversible: a deleted view can't be brought back.
  deleteView: { audience: "viewer", risk: "irreversible", mcp: true, target: (i) => `view:${i.id}`, run: async ({ deps, actor }, i) => ({ deleted: await deps.views.deleteView(i.id, personFor(actor, i.by)) }) },
};
