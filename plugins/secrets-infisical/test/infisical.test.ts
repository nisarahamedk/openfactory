import { SecretNotFound } from "@openfactory/contracts";
import { expect, test } from "vitest";
import { InfisicalSecrets } from "../src/index.js";

function fakeInfisical(values: Record<string, string>) {
  let logins = 0;
  const f: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/auth/universal-auth/login") {
      logins++;
      return Response.json({ accessToken: `tok${logins}`, expiresIn: 7200 });
    }
    if (!new Headers(init?.headers).get("authorization")?.startsWith("Bearer tok")) return new Response("no", { status: 401 });
    const name = decodeURIComponent(url.pathname.replace("/api/v3/secrets/raw/", ""));
    const value = values[name];
    return value === undefined ? new Response(JSON.stringify({ message: `Secret with name '${name}' not found` }), { status: 404 }) : Response.json({ secret: { secretKey: name, secretValue: value } });
  };
  return { fetch: f, logins: () => logins };
}

const make = (values: Record<string, string>) => {
  const fake = fakeInfisical(values);
  const secrets = new InfisicalSecrets({ siteUrl: "https://vault.example", clientId: "id", clientSecret: "s", projectId: "p", environment: "dev", secretPath: "/", gitTokenName: "GITHUB_TOKEN", fetch: fake.fetch, now: () => 0 });
  return { fake, secrets };
};

test("get reads a secret and reuses the login", async () => {
  const { fake, secrets } = make({ A: "1", B: "2" });
  expect(await secrets.get("A")).toBe("1");
  expect(await secrets.get("B")).toBe("2");
  expect(fake.logins()).toBe(1);
  await expect(secrets.get("MISSING")).rejects.toBeInstanceOf(SecretNotFound);
});

test("a repo-specific git token wins over the default", async () => {
  const repo = { host: "github" as const, owner: "acme", name: "web-app" };
  expect((await make({ GITHUB_TOKEN: "d", GITHUB_TOKEN_ACME_WEB_APP: "r" }).secrets.issue({ kind: "git", repo, access: "write" })).value).toBe("r");
  expect(await make({ GITHUB_TOKEN: "d" }).secrets.issue({ kind: "git", repo, access: "write" })).toEqual({ value: "d", expiresAt: null });
  await expect(make({}).secrets.issue({ kind: "git", repo, access: "read" })).rejects.toBeInstanceOf(SecretNotFound);
});
