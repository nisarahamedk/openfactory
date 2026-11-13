import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubAppAuth, githubAppFromEnv, provider } from "./index.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

function fakeGitHub(now: () => number) {
  const calls: Array<{ method: string; path: string; auth: string; body: unknown }> = [];
  let n = 0;
  const f = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const auth = String((init.headers as Record<string, string>).authorization).replace("Bearer ", "");
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init.method ?? "GET", path, auth, body });
    if (path.endsWith("/installation")) return Response.json({ id: 77 });
    if (path === "/app/installations/77/access_tokens") return Response.json({ token: `ghs_${++n}`, expires_at: new Date(now() + 3600_000).toISOString() });
    if (path === "/app") return Response.json({ slug: "acme-factory" });
    return new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("GitHub App auth", () => {
  it("signs a JWT the app's public key verifies", () => {
    const app = new GitHubAppAuth({ appId: "123", privateKey: pem, home: { owner: "acme", name: "app" } });
    const [h, p, s] = app.jwt().split(".");
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    expect(claims.iss).toBe("123");
    expect(claims.exp - claims.iat).toBe(540);
  });

  it("mints each task a token for its repo only, and caches the server's token until near expiry", async () => {
    let t = Date.parse("2026-11-13T00:00:00Z");
    const now = () => t;
    const gh = fakeGitHub(now);
    const app = new GitHubAppAuth({ appId: "123", privateKey: pem.replace(/\n/g, "\\n"), home: { owner: "acme", name: "app" }, fetch: gh.f, now });

    const task = await app.taskToken([{ host: "github", owner: "acme", name: "web" }]);
    expect(task.token).toBe("ghs_1");
    const mint = gh.calls.find((c) => c.path === "/app/installations/77/access_tokens")!;
    expect(mint.body).toEqual({ repositories: ["web"], permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read" } });

    expect(await app.serverToken()).toBe("ghs_2");
    expect(await app.serverToken()).toBe("ghs_2"); // cached
    t += 56 * 60_000; // within 5 minutes of expiry
    expect(await app.serverToken()).toBe("ghs_3");
    expect(gh.calls.filter((c) => c.path.endsWith("/installation"))).toHaveLength(1); // one installation lookup per owner
    expect(await app.botLogin()).toBe("acme-factory[bot]");
    await expect(app.taskToken([{ host: "github", owner: "acme", name: "a" }, { host: "github", owner: "other", name: "b" }])).rejects.toThrow("one owner");
  });

  it("the provider's codeForge hands out app tokens when the app is configured, the PAT otherwise", async () => {
    expect(githubAppFromEnv({ GITHUB_TOKEN: "x" })).toBeNull();
    const ctx = (env: Record<string, string>) => ({ env, options: {}, log: () => {} }) as never;
    const pat = await provider.provides.codeForge!(ctx({ GITHUB_TOKEN: "pat", FACTORY_REPOS: "acme/app" }));
    expect((await pat.mintPushToken({ host: "github", owner: "acme", name: "app" })).token).toBe("pat");
    const withApp = githubAppFromEnv({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem, FACTORY_REPOS: "acme/app, acme/web" });
    expect(withApp).toBeInstanceOf(GitHubAppAuth);
  });
});
