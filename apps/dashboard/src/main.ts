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
 */
const env = z
  .object({
    FACTORY_API_URL: z.string().url(),
    DASHBOARD_PORT: z.coerce.number().int().positive(),
    DASHBOARD_PASSWORD: z.string().min(1),
    FACTORY_API_TOKEN: z.string().min(1),
    DASHBOARD_MODELS: z.string().regex(/^[^,]+,[^,]+$/),
  })
  .parse(process.env);

const orNull = (v: string) => (v === "none" ? null : v);
const api = new FactoryApi({ baseUrl: env.FACTORY_API_URL, token: orNull(env.FACTORY_API_TOKEN) });
serve({ fetch: createDashboard(api, { password: orNull(env.DASHBOARD_PASSWORD), models: [env.DASHBOARD_MODELS.split(",")[0] ?? "", env.DASHBOARD_MODELS.split(",")[1] ?? ""] }).fetch, port: env.DASHBOARD_PORT }, (info) => {
  console.log(`dashboard listening on :${info.port}`);
});
