import { Hono } from "hono";
import { z } from "zod";
import { execSql } from "./sql.js";
import { Deployment, DxError, Incident, type DxStore } from "./store.js";

const CellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const SqlBody = z.object({ sql: z.string().min(1), params: z.array(CellSchema).default([]) });
const UpsertBody = z.object({
  table: z.string().regex(/^[a-z_][a-z0-9_]*$/),
  key: z.array(z.string()).min(1),
  rows: z.array(z.record(z.string(), CellSchema)),
});

/**
 * The fake DX HTTP API. Modelled on DX's shape (custom tables you write with SQL,
 * a Data Cloud style `deployments.create` / `incidents.upsert`), not a copy of it.
 * Every /api route needs `Authorization: Bearer <token>`.
 */
export function createDxFakeApp(store: DxStore, token: string): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof DxError) return c.json({ ok: false, error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({ ok: false, error: "invalid request body", issues: err.issues }, 400);
    console.error("dxfake: unexpected error", err);
    return c.json({ ok: false, error: "internal error" }, 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/", (c) => {
    const rows = store
      .tables()
      .map((t) => `<tr><td>custom.${t.name}</td><td>${t.key.join(", ")}</td><td>${t.rowCount}</td></tr>`)
      .join("");
    return c.html(
      `<!doctype html><meta charset="utf-8"><title>Fake DX</title><body style="font-family:system-ui;margin:2rem">` +
        `<h1>Fake DX</h1><p>A stand-in for a DX-style metrics platform. Data via the authenticated /api routes.</p>` +
        `<table border="1" cellpadding="6"><tr><th>table</th><th>key</th><th>rows</th></tr>${rows}</table>` +
        `<p>${store.deployments().length} deployments · ${store.incidents().length} incidents</p></body>`,
    );
  });

  app.use("/api/*", async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${token}`) throw new DxError(401, "missing or wrong bearer token");
    await next();
  });

  app.post("/api/sql", async (c) => {
    const body = SqlBody.parse(await c.req.json());
    return c.json({ ok: true, ...execSql(store, body.sql, body.params) });
  });

  app.post("/api/customTables.upsert", async (c) => {
    const body = UpsertBody.parse(await c.req.json());
    return c.json({ ok: true, ...store.upsert(body.table, body.key, body.rows) });
  });

  app.get("/api/customTables.list", (c) => c.json({ ok: true, tables: store.tables() }));

  app.get("/api/customTables.rows", (c) => {
    const table = z.string().min(1).parse(c.req.query("table"));
    return c.json({ ok: true, rows: store.rows(table) });
  });

  app.post("/api/deployments.create", async (c) => {
    const d = Deployment.parse(await c.req.json());
    store.addDeployment(d);
    return c.json({ ok: true, deployment: d });
  });
  app.get("/api/deployments.list", (c) => c.json({ ok: true, deployments: store.deployments() }));

  app.post("/api/incidents.upsert", async (c) => {
    const i = Incident.parse(await c.req.json());
    store.upsertIncident(i);
    return c.json({ ok: true, incident: i });
  });
  app.get("/api/incidents.list", (c) => c.json({ ok: true, incidents: store.incidents() }));

  return app;
}
