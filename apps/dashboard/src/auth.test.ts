import { describe, expect, it } from "vitest";
import { FactoryApi } from "@openfactory/client";
import { Hono } from "hono";
import { createDashboard } from "./app.js";
import { Auth, authFromEnv } from "./auth.js";

const SECRET = "x".repeat(40);

/** A fake GitHub: OAuth token exchange, /user and org membership. */
function fakeGitHub(login: string, member: boolean) {
  const seen: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    seen.push(u.pathname);
    if (u.pathname === "/login/oauth/access_token") {
      const body = new URLSearchParams(String(init?.body));
      if (body.get("code") !== "good" || !body.get("code_verifier")) return Response.json({ error: "bad" }, { status: 400 });
      return Response.json({ access_token: "gho_x" });
    }
    if (u.pathname === "/user") return Response.json({ login, name: "Ada" });
    if (u.pathname === "/user/memberships/orgs/acme") return member ? Response.json({ state: "active" }) : new Response("no", { status: 404 });
    return new Response("?", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, seen };
}

function server() {
  const s = new Hono();
  const posts: Array<{ path: string; body: unknown }> = [];
  s.get("/v1/factory", (c) => c.json({ factory: { version: "fv", providersFrom: "env", providers: {}, agent: { name: "a", model: "m" }, foreman: { model: "f" }, rules: { label: "factory", maxTaskUsd: 1, maxReviewRounds: 1, maxNudges: 1 }, prompts: { system: "", intake: "", review: "", foreman: "" } } }));
  s.get("/v1/health", (c) => c.json({ health: { at: "t", ok: true, checks: [] } }));
  s.get("/v1/tasks", (c) => c.json({ tasks: [] }));
  s.get("/v1/teams", (c) => c.json({ teams: [] }));
  s.get("/v1/factories", (c) => c.json({ factories: [], rollouts: [] }));
  s.post("/v1/*", async (c) => {
    posts.push({ path: c.req.path, body: await c.req.json().catch(() => null) });
    return c.json({}, 400);
  });
  s.get("/v1/views", (c) => c.json({ views: [] }));
  return { api: new FactoryApi({ baseUrl: "http://srv", token: null, fetch: (i, init) => Promise.resolve(s.fetch(new Request(i, init))) }), posts };
}

async function signIn(app: Hono) {
  const start = await app.request("/auth/start?back=%2Ftasks");
  const loc = new URL(start.headers.get("location")!);
  const stateCookie = start.headers.get("set-cookie")!.split(";")[0]!;
  const cb = await app.request(`/auth/callback?code=good&state=${loc.searchParams.get("state")}`, { headers: { cookie: stateCookie } });
  const session = cb.headers.getSetCookie().map((x) => x.split(";")[0]!).find((x) => x.startsWith("of_session=")) ?? "";
  return { loc, cb, session };
}

describe("sign-in", () => {
  const make = (login: string, member = true, extra: Partial<ConstructorParameters<typeof Auth>[0]> = {}) => {
    const gh = fakeGitHub(login, member);
    const auth = new Auth({ provider: "github", clientId: "cid", clientSecret: "cs", publicUrl: "https://app.example", sessionSecret: SECRET, admins: ["boss"], viewers: ["watcher"], defaultRole: "engineer", githubOrg: "acme", fetch: gh.f, ...extra });
    const { api, posts } = server();
    return { app: createDashboard(api, { password: "ignored-when-auth", models: ["a", "b"], auth }), posts, gh };
  };

  it("sends a signed-out person to sign in, then back where they were, signed in as their GitHub login", async () => {
    const { app, gh } = make("ada");
    const first = await app.request("/tasks?q=x");
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/signin?back=%2Ftasks%3Fq%3Dx");
    const { loc, cb, session } = await signIn(app);
    expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(loc.searchParams.get("scope")).toBe("read:user read:org");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(cb.headers.get("location")).toBe("/tasks");
    expect(gh.seen).toContain("/user/memberships/orgs/acme");
    const page = await (await app.request("/tasks", { headers: { cookie: session } })).text();
    expect(page).toContain("Signed in as <b");
    expect(page).toContain(">ada</b>");
  });

  it("refuses people outside the org, a forged state and a tampered cookie", async () => {
    const { app } = make("mallory", false);
    const { cb } = await signIn(app);
    expect(decodeURIComponent(cb.headers.get("location")!)).toContain("Only members of acme can sign in");

    const ok = make("ada").app;
    const start = await ok.request("/auth/start");
    const stateCookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const forged = await ok.request("/auth/callback?code=good&state=wrong", { headers: { cookie: stateCookie } });
    expect(decodeURIComponent(forged.headers.get("location")!)).toContain("didn't match");

    const auth = new Auth({ provider: "github", clientId: "c", clientSecret: "s", publicUrl: "https://app.example", sessionSecret: SECRET, admins: [], engineers: ["ada"], viewers: [], defaultRole: "engineer" });
    const token = auth.sign(auth.newSession("ada", null));
    const [body, mac] = token.split(".");
    const evil = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), role: "admin" })).toString("base64url");
    expect(auth.session(`${evil}.${mac}`)).toBeNull();
    expect(auth.session(token)?.login).toBe("ada");
  });

  it("enforces roles on writes and refuses cross-site posts", async () => {
    const viewer = make("watcher");
    const v = await signIn(viewer.app);
    const stop = await viewer.app.request("/tasks/task_a/cancel", { method: "POST", headers: { cookie: v.session, origin: "https://app.example" }, body: new URLSearchParams({}) });
    expect(decodeURIComponent(stop.headers.get("location")!)).toContain("needs the engineer role");
    expect(viewer.posts).toHaveLength(0);

    const eng = make("ada");
    const e = await signIn(eng.app);
    const rollout = await eng.app.request("/factories/default/rollout", { method: "POST", headers: { cookie: e.session }, body: new URLSearchParams({}) });
    expect(decodeURIComponent(rollout.headers.get("location")!)).toContain("needs the admin role");
    const xsite = await eng.app.request("/tasks/task_a/cancel", { method: "POST", headers: { cookie: e.session, origin: "https://evil.example" }, body: new URLSearchParams({}) });
    expect(xsite.status).toBe(403);
    const anon = await eng.app.request("/tasks/task_a/cancel", { method: "POST", body: new URLSearchParams({}) });
    expect(anon.status).toBe(401);
  });

  it("is configured from env, and needs its secrets", () => {
    expect(authFromEnv({})).toBeNull();
    expect(() => authFromEnv({ AUTH_PROVIDER: "github" })).toThrow("AUTH_CLIENT_ID");
    const a = authFromEnv({ AUTH_PROVIDER: "oidc", AUTH_CLIENT_ID: "c", AUTH_CLIENT_SECRET: "s", DASHBOARD_PUBLIC_URL: "https://app.example", SESSION_SECRET: SECRET, OIDC_ISSUER: "https://idp.example", AUTH_ADMINS: "boss" })!;
    expect(a.roleOf("BOSS")).toBe("admin");
    expect(a.roleOf("ada")).toBe("viewer");
  });

  it("lets nobody in by default: github with no org and no lists refuses to start", () => {
    const base = { AUTH_PROVIDER: "github", AUTH_CLIENT_ID: "c", AUTH_CLIENT_SECRET: "s", DASHBOARD_PUBLIC_URL: "https://app.example", SESSION_SECRET: SECRET };
    expect(() => authFromEnv(base)).toThrow("lets any GitHub user in");
    const listed = authFromEnv({ ...base, AUTH_ENGINEERS: "ada", AUTH_ADMINS: "boss" })!;
    expect(listed.roleOf("ada")).toBe("engineer");
    expect(listed.roleOf("boss")).toBe("admin");
    expect(listed.roleOf("stranger")).toBeNull();
    expect(authFromEnv({ ...base, AUTH_GITHUB_ORG: "acme" })!.roleOf("member")).toBe("viewer");
  });

  it("refuses a GitHub user on no list when there is no org, and lets a listed one in", async () => {
    const stranger = make("stranger", true, { githubOrg: null, admins: [], viewers: [], engineers: ["ada"] });
    const s = await signIn(stranger.app);
    expect(decodeURIComponent(s.cb.headers.get("location")!)).toContain("isn't allowed into this factory");
    expect(s.session).toBe("");
    expect(stranger.gh.seen).not.toContain("/user/memberships/orgs/acme");

    const ada = make("ada", false, { githubOrg: null, admins: [], viewers: [], engineers: ["ada"] });
    const a = await signIn(ada.app);
    expect(a.cb.headers.get("location")).toBe("/tasks");
  });

  it("lets a listed person in without org membership, and gives unlisted members the default role", async () => {
    const listed = make("watcher", false);
    expect((await signIn(listed.app)).cb.headers.get("location")).toBe("/tasks");
    const auth = new Auth({ provider: "github", clientId: "c", clientSecret: "s", publicUrl: "https://app.example", sessionSecret: SECRET, admins: [], viewers: [], defaultRole: "viewer", githubOrg: "acme" });
    expect(auth.newSession("member", null).role).toBe("viewer");
  });

  it("works the role out again on every request, so removing someone takes effect at once", () => {
    const admins = ["boss"];
    const auth = new Auth({ provider: "github", clientId: "c", clientSecret: "s", publicUrl: "https://app.example", sessionSecret: SECRET, admins, viewers: [], engineers: ["ada"], defaultRole: "viewer" });
    const boss = auth.sign(auth.newSession("boss", null));
    const ada = auth.sign(auth.newSession("ada", null));
    expect(auth.session(boss)?.role).toBe("admin");
    admins.length = 0;
    expect(auth.session(boss)).toBeNull();
    auth.cfg.viewers.push("ada");
    expect(auth.session(ada)?.role).toBe("engineer");
    (auth.cfg.engineers as string[]).length = 0;
    expect(auth.session(ada)?.role).toBe("viewer");
  });

  it("with OIDC_EMAIL_DOMAINS, refuses emails from other domains", async () => {
    const f = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/.well-known/openid-configuration") return Response.json({ authorization_endpoint: "https://idp.example/auth", token_endpoint: "https://idp.example/token", userinfo_endpoint: "https://idp.example/userinfo" });
      if (u.pathname === "/token") return Response.json({ access_token: "at" });
      if (u.pathname === "/userinfo") return Response.json({ preferred_username: "alice@other.com", email: "alice@other.com", email_verified: true });
      return new Response("?", { status: 404 });
    }) as unknown as typeof fetch;
    const auth = new Auth({ provider: "oidc", clientId: "c", clientSecret: "s", publicUrl: "https://app.example", sessionSecret: SECRET, admins: [], viewers: [], defaultRole: "viewer", oidcIssuer: "https://idp.example", oidcEmailDomains: ["acme.com"], fetch: f });
    const { url, state } = await auth.start("/");
    await expect(auth.finish({ code: "x", state: new URL(url).searchParams.get("state")!, cookie: state })).rejects.toThrow("Only company accounts");
  });
});
