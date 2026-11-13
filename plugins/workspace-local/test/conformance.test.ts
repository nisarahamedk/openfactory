import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeWorkspaceConformance, makeOriginRepo } from "@openfactory/conformance";
import { LocalWorkspace, provider } from "../src/index.js";

describeWorkspaceConformance("workspace-local", async () => {
  const origin = makeOriginRepo();
  const root = mkdtempSync(join(tmpdir(), "of-local-"));
  return {
    subject: new LocalWorkspace({ root, cloneUrl: () => origin.path, baseEnv: {} }),
    repo: { host: "github", owner: "acme", name: "app" },
    olderCommit: origin.olderCommit,
    cleanup: async () => {
      origin.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
});

describe("provider", () => {
  const log = () => undefined;
  it("reads options first, env as fallback, and rejects unknown options", async () => {
    const make = provider.provides.workspace!;
    expect((await make({ options: { root: "/opt" }, env: { WORKSPACE_ROOT: "/env" }, log })).name).toBe("local");
    expect((await make({ options: {}, env: { WORKSPACE_ROOT: "/env" }, log })).name).toBe("local");
    await expect(async () => make({ options: {}, env: {}, log })).rejects.toThrow(/WORKSPACE_ROOT/);
    await expect(async () => make({ options: { rooot: "/x" }, env: {}, log })).rejects.toThrow(/unknown option "rooot"/);
    await expect(async () => make({ options: { gitTokenEnv: 3 }, env: { WORKSPACE_ROOT: "/env" }, log })).rejects.toThrow(/names an env var/);
  });
});
