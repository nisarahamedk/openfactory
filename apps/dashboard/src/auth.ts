/**
 * Sign-in for the factory app: GitHub (OAuth) or any OpenID Connect provider (Okta, Entra, Google, Keycloak,
 * Dex...). The app keeps a signed session cookie; every write is made as the signed-in person, with their role.
 *
 * Roles:
 *   viewer    reads everything, saves views
 *   engineer  also asks for tasks, writes to them, stops and retries them, turns them into benchmarks
 *   admin     also changes factory rollouts and starts paid benchmark runs
 *
 * With no provider configured the app falls back to the shared password and the name picker (dev only).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type Role = "viewer" | "engineer" | "admin";
export const ROLE_RANK: Record<Role, number> = { viewer: 0, engineer: 1, admin: 2 };

export type Session = { login: string; name: string | null; role: Role; exp: number };

export type AuthConfig = {
  /** "github": sign in with GitHub, the login is the GitHub login. "oidc": any OIDC provider. */
  provider: "github" | "oidc";
  clientId: string;
  clientSecret: string;
  /** The app's public URL; the callback is <publicUrl>/auth/callback. */
  publicUrl: string;
  /** At least 32 characters; signs session cookies. */
  sessionSecret: string;
  /** Logins with each role. Anyone else allowed in gets `defaultRole`. */
  admins: string[];
  viewers: string[];
  defaultRole: Role;
  /** github: only members of this org may sign in (needs the read:org scope). */
  githubOrg?: string | null;
  githubApiUrl?: string;
  githubWebUrl?: string;
  /** oidc: the issuer (discovery at <issuer>/.well-known/openid-configuration) and the claim used as login. */
  oidcIssuer?: string;
  oidcLoginClaim?: string;
  sessionHours?: number;
  fetch?: typeof fetch;
  now?: () => number;
};

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export class Auth {
  private discovery: Promise<{ authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string }> | null = null;
  constructor(readonly cfg: AuthConfig) {
    if (cfg.sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  }

  private get f() {
    return this.cfg.fetch ?? fetch;
  }
  private now() {
    return this.cfg.now?.() ?? Date.now();
  }
  get callbackUrl() {
    return `${this.cfg.publicUrl.replace(/\/$/, "")}/auth/callback`;
  }
  get origin() {
    return new URL(this.cfg.publicUrl).origin;
  }

  // ── signed values (session and the sign-in state) ──
  sign(value: object): string {
    const body = b64(JSON.stringify(value));
    return `${body}.${b64(createHmac("sha256", this.cfg.sessionSecret).update(body).digest())}`;
  }
  unsign<T>(token: string | undefined): T | null {
    if (!token) return null;
    const [body, mac] = token.split(".");
    if (!body || !mac) return null;
    const want = createHmac("sha256", this.cfg.sessionSecret).update(body).digest();
    const got = Buffer.from(mac, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try {
      return JSON.parse(Buffer.from(body, "base64url").toString()) as T;
    } catch {
      return null;
    }
  }

  session(cookie: string | undefined): Session | null {
    const s = this.unsign<Session>(cookie);
    return s && typeof s.login === "string" && s.exp > this.now() ? s : null;
  }

  roleOf(login: string): Role {
    const l = login.toLowerCase();
    if (this.cfg.admins.some((a) => a.toLowerCase() === l)) return "admin";
    if (this.cfg.viewers.some((v) => v.toLowerCase() === l)) return "viewer";
    return this.cfg.defaultRole;
  }

  newSession(login: string, name: string | null): Session {
    return { login, name, role: this.roleOf(login), exp: this.now() + (this.cfg.sessionHours ?? 12) * 3600_000 };
  }

  // ── the sign-in flow ──
  /** Where to send the browser, and the signed state to keep in a short cookie until the callback. */
  async start(back: string): Promise<{ url: string; state: string }> {
    const state = b64(randomBytes(18));
    const verifier = b64(randomBytes(32));
    const challenge = b64(createHash("sha256").update(verifier).digest());
    const signed = this.sign({ state, verifier, back, exp: this.now() + 10 * 60_000 });
    if (this.cfg.provider === "github") {
      const u = new URL(`${(this.cfg.githubWebUrl ?? "https://github.com").replace(/\/$/, "")}/login/oauth/authorize`);
      u.searchParams.set("client_id", this.cfg.clientId);
      u.searchParams.set("redirect_uri", this.callbackUrl);
      u.searchParams.set("scope", this.cfg.githubOrg ? "read:user read:org" : "read:user");
      u.searchParams.set("state", state);
      u.searchParams.set("code_challenge", challenge);
      u.searchParams.set("code_challenge_method", "S256");
      u.searchParams.set("allow_signup", "false");
      return { url: u.toString(), state: signed };
    }
    const d = await this.discover();
    const u = new URL(d.authorization_endpoint);
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("redirect_uri", this.callbackUrl);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "openid profile email");
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
    return { url: u.toString(), state: signed };
  }

  /**
   * Finish sign-in: check the state, trade the code for a token, find who it is. Throws a message fit to show
   * the person when they may not sign in.
   */
  async finish(input: { code: string | undefined; state: string | undefined; cookie: string | undefined }): Promise<{ session: Session; back: string }> {
    const kept = this.unsign<{ state: string; verifier: string; back: string; exp: number }>(input.cookie);
    if (!kept || kept.exp < this.now() || !input.state || kept.state !== input.state || !input.code) throw new Error("The sign-in expired or didn't match. Please try again.");
    const who = this.cfg.provider === "github" ? await this.github(input.code, kept.verifier) : await this.oidc(input.code, kept.verifier);
    return { session: this.newSession(who.login, who.name), back: kept.back };
  }

  private async form(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.f(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof json.access_token !== "string") throw new Error("The identity provider refused the sign-in. Please try again.");
    return json;
  }

  private async github(code: string, verifier: string): Promise<{ login: string; name: string | null }> {
    const t = await this.form(`${(this.cfg.githubWebUrl ?? "https://github.com").replace(/\/$/, "")}/login/oauth/access_token`, {
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      code,
      redirect_uri: this.callbackUrl,
      code_verifier: verifier,
    });
    const api = (this.cfg.githubApiUrl ?? "https://api.github.com").replace(/\/$/, "");
    const headers = { authorization: `Bearer ${t.access_token}`, accept: "application/vnd.github+json", "user-agent": "openfactory" };
    const user = (await (await this.f(`${api}/user`, { headers })).json()) as { login?: string; name?: string | null };
    if (!user.login) throw new Error("GitHub didn't say who you are. Please try again.");
    if (this.cfg.githubOrg) {
      const m = await this.f(`${api}/user/memberships/orgs/${encodeURIComponent(this.cfg.githubOrg)}`, { headers });
      const body = m.ok ? ((await m.json()) as { state?: string }) : null;
      if (body?.state !== "active") throw new Error(`Only members of ${this.cfg.githubOrg} can sign in to this factory.`);
    }
    return { login: user.login, name: user.name ?? null };
  }

  private discover() {
    this.discovery ??= (async () => {
      const issuer = (this.cfg.oidcIssuer ?? "").replace(/\/$/, "");
      const res = await this.f(`${issuer}/.well-known/openid-configuration`);
      if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
      return (await res.json()) as { authorization_endpoint: string; token_endpoint: string; userinfo_endpoint: string };
    })();
    this.discovery.catch(() => (this.discovery = null));
    return this.discovery;
  }

  private async oidc(code: string, verifier: string): Promise<{ login: string; name: string | null }> {
    const d = await this.discover();
    const t = await this.form(d.token_endpoint, {
      grant_type: "authorization_code",
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      code,
      redirect_uri: this.callbackUrl,
      code_verifier: verifier,
    });
    // Userinfo over TLS with the fresh access token: no need to verify the id_token's signature ourselves.
    const info = (await (await this.f(d.userinfo_endpoint, { headers: { authorization: `Bearer ${t.access_token}` } })).json()) as Record<string, unknown>;
    const claim = this.cfg.oidcLoginClaim ?? "preferred_username";
    const raw = info[claim];
    if (typeof raw !== "string" || raw === "") throw new Error(`The identity provider didn't send "${claim}". Ask an admin to set OIDC_LOGIN_CLAIM.`);
    // Logins are matched to code-host logins (who asked, reviewers), so keep the part before any @.
    const login = raw.split("@")[0]!;
    return { login, name: typeof info.name === "string" ? info.name : null };
  }
}

/** Sign-in from env, or null when none is configured (then the app keeps basic auth and the name picker). */
export function authFromEnv(env: Record<string, string | undefined>): Auth | null {
  const provider = env.AUTH_PROVIDER;
  if (!provider || provider === "none") return null;
  if (provider !== "github" && provider !== "oidc") throw new Error('AUTH_PROVIDER must be "github", "oidc" or "none"');
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is required with AUTH_PROVIDER=${provider}`);
    return v;
  };
  const list = (k: string) => (env[k] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const role = env.AUTH_DEFAULT_ROLE ?? "engineer";
  if (role !== "viewer" && role !== "engineer" && role !== "admin") throw new Error("AUTH_DEFAULT_ROLE must be viewer, engineer or admin");
  return new Auth({
    provider,
    clientId: need("AUTH_CLIENT_ID"),
    clientSecret: need("AUTH_CLIENT_SECRET"),
    publicUrl: need("DASHBOARD_PUBLIC_URL"),
    sessionSecret: need("SESSION_SECRET"),
    admins: list("AUTH_ADMINS"),
    viewers: list("AUTH_VIEWERS"),
    defaultRole: role,
    githubOrg: env.AUTH_GITHUB_ORG || null,
    ...(provider === "oidc" ? { oidcIssuer: need("OIDC_ISSUER"), oidcLoginClaim: env.OIDC_LOGIN_CLAIM || "preferred_username" } : {}),
  });
}
