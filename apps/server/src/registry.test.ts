import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineProvider } from "@openfactory/contracts";
import { describe, expect, it } from "vitest";
import { loadOutcomeConfig, loadSelections, parseFactoryFile, ProviderRegistry, selectionsFromEnv } from "./registry.js";

describe("factory.yaml", () => {
  it("parses short and long provider forms and rejects unknown abstractions", () => {
    const s = parseFactoryFile(`providers:\n  codeForge: github\n  workspace: { k8s: { namespace: ws } }\n  devEnvironment: none\n`);
    expect(s).toEqual({
      codeForge: { name: "github", options: {} },
      workspace: { name: "k8s", options: { namespace: "ws" } },
      devEnvironment: { name: "none", options: {} },
    });
    expect(() => parseFactoryFile("providers:\n  teleporter: x\n")).toThrow();
  });

  it("falls back to env vars", () => {
    expect(selectionsFromEnv({ ENV_PLUGIN: "none", SIGNALS: "webhook" })).toMatchObject({ devEnvironment: { name: "none" }, agent: { name: "acp" } });
    expect(selectionsFromEnv({ SIGNALS: "webhook" }).signals).toBeUndefined();
    expect(loadSelections({}, "/nope/factory.yaml").source).toBe("env");
  });
});

describe("ProviderRegistry", () => {
  const chat = { name: "fake", post: async () => ({ url: "u" }) };
  const importer = async (pkg: string) => {
    if (pkg === "@openfactory/github") return { provider: defineProvider({ name: "github", provides: { chat: (ctx) => ({ ...chat, name: String(ctx.options.flavour ?? "fake") }) } }) };
    if (pkg === "@openfactory/workspace-k8s") return { fromEnv: (env: Record<string, string | undefined>) => ({ name: `k8s:${env.WORKSPACE_NAMESPACE}`, create: async () => null, get: async () => null }) };
    throw new Error(`no ${pkg}`);
  };
  const reg = new ProviderRegistry({}, () => {}, importer as never);

  it("builds from provider exports and older fromEnv packages", async () => {
    expect((await reg.build("chat", { name: "github", options: { flavour: "x" } })).name).toBe("x");
    expect((await reg.build("workspace", { name: "k8s", options: { workspaceNamespace: "ws" } })).name).toBe("k8s:ws");
    expect((await reg.build("devEnvironment", { name: "none", options: {} })).name).toBe("none");
    await expect(reg.build("codeForge", { name: "github", options: {} })).rejects.toThrow(/does not provide/);
    expect(ProviderRegistry.packageFor("gitlab")).toBe("@openfactory/provider-gitlab");
  });
});

describe("outcome sources", () => {
  it("default to github, plus dxfake when it is configured; OUTCOMES=off turns them off", () => {
    expect(loadOutcomeConfig({})).toEqual({ sources: [{ name: "github", options: {} }], windowDays: 30, intervalMs: 600_000 });
    expect(loadOutcomeConfig({ DXFAKE_URL: "http://dx", DXFAKE_TOKEN: "t", OUTCOME_INTERVAL_MS: "60000" })!.sources.map((s) => s.name)).toEqual(["github", "dxfake"]);
    expect(loadOutcomeConfig({ DXFAKE_URL: "http://dx", DXFAKE_TOKEN: "t", OUTCOME_INTERVAL_MS: "60000" })!.intervalMs).toBe(60_000);
    expect(loadOutcomeConfig({ OUTCOMES: "off" })).toBeNull();
  });

  it("factory.yaml lists them", () => {
    const dir = mkdtempSync(join(tmpdir(), "of-"));
    const path = join(dir, "factory.yaml");
    writeFileSync(path, "outcomes:\n  sources: [github, { dxfake: { url: http://dx } }]\n  windowDays: 14\n");
    expect(loadOutcomeConfig({}, path)).toEqual({
      sources: [{ name: "github", options: {} }, { name: "dxfake", options: { url: "http://dx" } }],
      windowDays: 14,
      intervalMs: 600_000,
    });
  });
});
