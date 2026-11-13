import { expect, test } from "vitest";
import { gitTokenNames } from "../src/git-token-names.js";

test("a repo-specific token name comes before the default", () => {
  expect(gitTokenNames({ host: "github", owner: "acme", name: "web.app" }, "GITHUB_TOKEN")).toEqual(["GITHUB_TOKEN_ACME_WEB_APP", "GITHUB_TOKEN"]);
});
