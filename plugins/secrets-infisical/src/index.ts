/**
 * Secrets from Infisical, read with a machine identity (universal auth).
 * Infisical holds static values, so issued git tokens are long-lived
 * (expiresAt null). For short-lived push tokens use a GitHub App provider.
 */
import { z } from "zod";
import { SecretNotFound, type IssuedSecret, type SecretRequest, type Secrets } from "@openfactory/contracts";
import { gitTokenNames } from "./git-token-names.js";

export interface InfisicalSecretsOptions {
  siteUrl: string;
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string;
  secretPath: string;
  /** Default secret name for git tokens; a repo-specific one wins if present. */
  gitTokenName: string;
  fetch: typeof fetch;
  now: () => number;
}

/** Infisical refused a request. */
export class InfisicalRequestFailed extends Error {
  readonly code = "infisical_request_failed" as const;
  constructor(
    readonly path: string,
    readonly status: number,
  ) {
    super(`Infisical ${path} failed with ${status}`);
  }
}

const Login = z.object({ accessToken: z.string(), expiresIn: z.number() });
const SecretBody = z.object({ secret: z.object({ secretValue: z.string() }) });

export class InfisicalSecrets implements Secrets {
  readonly name = "infisical";
  private token: { value: string; until: number } | null = null;

  constructor(private readonly options: InfisicalSecretsOptions) {}

  async get(name: string): Promise<string> {
    const query = new URLSearchParams({
      workspaceId: this.options.projectId,
      environment: this.options.environment,
      secretPath: this.options.secretPath,
    });
    const path = `/api/v3/secrets/raw/${encodeURIComponent(name)}`;
    const res = await this.options.fetch(`${this.base()}${path}?${query}`, {
      headers: { authorization: `Bearer ${await this.accessToken()}` },
    });
    if (res.status === 404) throw new SecretNotFound(name, this.name);
    // Infisical answers a missing secret with 400 on some versions; tell it apart from other failures.
    if (res.status === 400 && /not found/i.test(await res.clone().text())) throw new SecretNotFound(name, this.name);
    if (!res.ok) throw new InfisicalRequestFailed(path, res.status);
    return SecretBody.parse(await res.json()).secret.secretValue;
  }

  async issue(request: SecretRequest): Promise<IssuedSecret> {
    for (const name of gitTokenNames(request.repo, this.options.gitTokenName)) {
      try {
        return { value: await this.get(name), expiresAt: null };
      } catch (error) {
        if (!(error instanceof SecretNotFound)) throw error;
      }
    }
    throw new SecretNotFound(this.options.gitTokenName, this.name);
  }

  private base(): string {
    return this.options.siteUrl.replace(/\/$/, "");
  }

  private async accessToken(): Promise<string> {
    if (this.token !== null && this.token.until > this.options.now()) return this.token.value;
    const path = "/api/v1/auth/universal-auth/login";
    const res = await this.options.fetch(`${this.base()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: this.options.clientId, clientSecret: this.options.clientSecret }),
    });
    if (!res.ok) throw new InfisicalRequestFailed(path, res.status);
    const login = Login.parse(await res.json());
    // Renew a minute early so a request never carries an expired token.
    this.token = { value: login.accessToken, until: this.options.now() + Math.max(0, login.expiresIn - 60) * 1000 };
    return login.accessToken;
  }
}

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key];
  if (value === undefined || value === "") throw new Error(`secrets-infisical needs ${key}`);
  return value;
}

/** Builds the provider from settings. See README.md. */
export function fromEnv(env: Env): InfisicalSecrets {
  return new InfisicalSecrets({
    siteUrl: env.INFISICAL_SITE_URL ?? "https://app.infisical.com",
    clientId: required(env, "INFISICAL_CLIENT_ID"),
    clientSecret: required(env, "INFISICAL_CLIENT_SECRET"),
    projectId: required(env, "INFISICAL_PROJECT_ID"),
    environment: env.INFISICAL_ENVIRONMENT ?? "dev",
    secretPath: env.INFISICAL_SECRET_PATH ?? "/",
    gitTokenName: env.SECRETS_GIT_TOKEN_NAME ?? "GITHUB_TOKEN",
    fetch,
    now: Date.now,
  });
}

export const createInfisicalSecrets = (options: InfisicalSecretsOptions): InfisicalSecrets => new InfisicalSecrets(options);
export { provider } from "./provider.js";
