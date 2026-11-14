#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { z } from "zod";
import { FactoryApi } from "@openfactory/client";
import { createDashboard } from "./app.js";
import { authFromEnv } from "./auth.js";

/**
 * Runs the dashboard.
 *   FACTORY_API_URL     factory server base URL, e.g. http://openfactory:3000 (required)
 *   DASHBOARD_PORT      port to listen on (required)
 *   DASHBOARD_PASSWORD  basic-auth password for user "factory", or "none" to disable (required without AUTH_PROVIDER)
 *   FACTORY_API_TOKEN   bearer token for the server API, or "none" (required)
 *   DASHBOARD_MODELS    default models for arms A and B, comma-separated model-proxy names (required)
 *   DASHBOARD_FACTORY_NAME  name shown in the sidebar (optional, default "main")
 *   FACTORY_PUBLIC_URL      public URL of the factory server, to show its MCP endpoint (optional)
 *
 * Sign-in (recommended; replaces the shared password and the name picker). See auth.ts:
 *   AUTH_PROVIDER       github | oidc | none (default none)
 *   AUTH_CLIENT_ID, AUTH_CLIENT_SECRET   the OAuth app or OIDC client
 *   DASHBOARD_PUBLIC_URL  this app's public URL (callback: <url>/auth/callback)
 *   SESSION_SECRET      32+ random characters, signs session cookies
 *   AUTH_ADMINS, AUTH_ENGINEERS, AUTH_VIEWERS  comma-separated logins with each role (always let in)
 *   AUTH_DEFAULT_ROLE   role of unlisted people the org lets in (default viewer)
 *   AUTH_GITHUB_ORG     github: members of this org may sign in. With no org, only listed logins may.
 *   OIDC_ISSUER, OIDC_LOGIN_CLAIM  oidc: the issuer (one org's IdP), and the claim used as login (default preferred_username)
 *   OIDC_EMAIL_DOMAINS  oidc: only these email domains may sign in (needed with a shared issuer such as Google)
 */
const env = z
  .object({
    FACTORY_API_URL: z.string().url(),
    DASHBOARD_PORT: z.coerce.number().int().positive(),
    DASHBOARD_PASSWORD: z.string().min(1).optional(),
    FACTORY_API_TOKEN: z.string().min(1),
    DASHBOARD_MODELS: z.string().regex(/^[^,]+,[^,]+$/),
    DASHBOARD_FACTORY_NAME: z.string().min(1).max(40).default("main"),
    FACTORY_PUBLIC_URL: z.string().url().optional(),
  })
  .parse(process.env);

const orNull = (v: string) => (v === "none" ? null : v);
const api = new FactoryApi({ baseUrl: env.FACTORY_API_URL, token: orNull(env.FACTORY_API_TOKEN) });
const auth = authFromEnv(process.env);
if (!auth && env.DASHBOARD_PASSWORD === undefined) throw new Error('Set AUTH_PROVIDER (sign-in) or DASHBOARD_PASSWORD ("none" to run open, dev only).');
serve({ fetch: createDashboard(api, { auth, password: env.DASHBOARD_PASSWORD === undefined ? null : orNull(env.DASHBOARD_PASSWORD), models: [env.DASHBOARD_MODELS.split(",")[0] ?? "", env.DASHBOARD_MODELS.split(",")[1] ?? ""], factoryName: env.DASHBOARD_FACTORY_NAME, mcpUrl: env.FACTORY_PUBLIC_URL ? `${env.FACTORY_PUBLIC_URL.replace(/\/$/, "")}/mcp` : null, publicApiUrl: env.FACTORY_PUBLIC_URL ?? null }).fetch, port: env.DASHBOARD_PORT }, (info) => {
  console.log(`dashboard listening on :${info.port}`);
});
