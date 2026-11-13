#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { z } from "zod";
import { createDxFakeApp } from "./server.js";
import { DxStore } from "./store.js";

/**
 * Runs the fake DX service.
 *   DXFAKE_TOKEN      bearer token clients must send (required)
 *   DXFAKE_PORT       port to listen on (required, e.g. 8787)
 *   DXFAKE_DATA_FILE  JSON file to persist to, or "memory"
 */
const env = z
  .object({
    DXFAKE_TOKEN: z.string().min(16),
    DXFAKE_PORT: z.coerce.number().int().positive(),
    DXFAKE_DATA_FILE: z.string().min(1),
  })
  .parse(process.env);

const store = new DxStore(env.DXFAKE_DATA_FILE === "memory" ? null : env.DXFAKE_DATA_FILE);
serve({ fetch: createDxFakeApp(store, env.DXFAKE_TOKEN).fetch, port: env.DXFAKE_PORT }, (info) => {
  console.log(`fake DX listening on :${info.port}`);
});
