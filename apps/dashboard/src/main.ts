#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { z } from "zod";
import { FactoryApi } from "@openfactory/client";
import { createDashboard } from "./app.js";

/**
 * Runs the dashboard.
 *   FACTORY_API_URL     factory server base URL, e.g. http://openfactory:3000 (required)
 *   DASHBOARD_PORT      port to listen on (required)
 *   DASHBOARD_PASSWORD  basic-auth password for user "factory", or "none" to disable (required)
 *   FACTORY_API_TOKEN   bearer token for the server API, or "none" (required)
 *   DASHBOARD_MODELS    default models for arms A and B, comma-separated model-proxy names (required)
 *   DASHBOARD_FACTORY_NAME  name shown in the sidebar (optional, default "main")
 *   FACTORY_PUBLIC_URL      public URL of the factory server, to show its MCP endpoint (optional)
 */
const env = z
  .object({
    FACTORY_API_URL: z.string().url(),
    DASHBOARD_PORT: z.coerce.number().int().positive(),
    DASHBOARD_PASSWORD: z.string().min(1),
    FACTORY_API_TOKEN: z.string().min(1),
    DASHBOARD_MODELS: z.string().regex(/^[^,]+,[^,]+$/),
    DASHBOARD_FACTORY_NAME: z.string().min(1).max(40).default("main"),
    FACTORY_PUBLIC_URL: z.string().url().optional(),
  })
  .parse(process.env);

const orNull = (v: string) => (v === "none" ? null : v);
const api = new FactoryApi({ baseUrl: env.FACTORY_API_URL, token: orNull(env.FACTORY_API_TOKEN) });
serve({ fetch: createDashboard(api, { password: orNull(env.DASHBOARD_PASSWORD), models: [env.DASHBOARD_MODELS.split(",")[0] ?? "", env.DASHBOARD_MODELS.split(",")[1] ?? ""], factoryName: env.DASHBOARD_FACTORY_NAME, mcpUrl: env.FACTORY_PUBLIC_URL ? `${env.FACTORY_PUBLIC_URL.replace(/\/$/, "")}/mcp` : null }).fetch, port: env.DASHBOARD_PORT }, (info) => {
  console.log(`dashboard listening on :${info.port}`);
});
