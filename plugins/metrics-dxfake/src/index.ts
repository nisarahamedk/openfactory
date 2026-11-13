export { createDxFakeApp } from "./server.js";
export { DxStore, DxError, Deployment, Incident, type Cell, type Row } from "./store.js";
export { execSql, type SqlResult } from "./sql.js";
export { DxFakeSink, DxFakeOutcomeSource, FACTORY_TASKS_TABLE, taskRow, type DxFakeConfig } from "./sink.js";

import { defineProvider } from "@openfactory/contracts";
import { DxFakeSink as Sink } from "./sink.js";

/** factory.yaml: `metrics: { dxfake: { url: https://dx.example, tokenEnv: DXFAKE_TOKEN } }` (env DXFAKE_URL as fallback). */
export const provider = defineProvider({
  name: "dxfake",
  provides: {
    metrics: (ctx) => {
      const baseUrl = typeof ctx.options.url === "string" ? ctx.options.url : ctx.env.DXFAKE_URL;
      const token = ctx.env[typeof ctx.options.tokenEnv === "string" ? ctx.options.tokenEnv : "DXFAKE_TOKEN"];
      if (!baseUrl || !token) throw new Error("dxfake provider: url and token (DXFAKE_URL, DXFAKE_TOKEN) are required");
      return new Sink({ baseUrl, token });
    },
  },
});
