import { describe, expect, it } from "vitest";
import { AgentGaveUp, classifyError, SetupError } from "./errors.js";

const kind = (m: string, e: unknown = new Error(m)) => classifyError(e, m).kind;

describe("classifyError", () => {
  it("treats blips as passing", () => {
    expect(kind("fetch failed")).toBe("passing");
    expect(kind("read ECONNRESET")).toBe("passing");
    expect(kind("Unknown (status 503)")).toBe("passing");
    expect(kind("GitHub POST /repos/a/b/pulls → 502: bad gateway")).toBe("passing");
    expect(kind("GitHub GET /repos/a/b → 403: API rate limit exceeded")).toBe("passing");
    expect(kind("Overloaded")).toBe("passing");
  });

  it("treats setup mistakes as setup, with a fix", () => {
    const live = "ACP request session/prompt failed (-32603): Internal error: There's an issue with the selected model (claude-sonnet). It may not exist or you may not have access to it.";
    expect(classifyError(new Error(live), live)).toMatchObject({ kind: "setup", fix: expect.stringContaining("model") });
    expect(kind("GitHub GET /repos/a/b → 404: Not Found")).toBe("setup");
    expect(kind("GitHub POST /repos/a/b/pulls → 403: Resource not accessible by personal access token")).toBe("setup");
    expect(kind("Bad credentials")).toBe("setup");
    expect(classifyError(new SetupError("x", "do y"), "x")).toEqual({ kind: "setup", fix: "do y" });
  });

  it("knows the agent giving up, and leaves the rest unknown", () => {
    expect(kind("no reviewable result", new AgentGaveUp("no reviewable result"))).toBe("agent");
    expect(kind("[object Object]")).toBe("unknown");
  });
});
