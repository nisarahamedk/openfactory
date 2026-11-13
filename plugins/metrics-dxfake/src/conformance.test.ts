import { describeMetricsSinkConformance } from "@openfactory/conformance";
import { z } from "zod";
import { createDxFakeApp, DxFakeSink, DxStore } from "./index.js";

const TOKEN = "conformance-token-0123";

describeMetricsSinkConformance("DxFakeSink", async () => {
  const app = createDxFakeApp(new DxStore(null), TOKEN);
  const fetchVia: typeof fetch = (i, init) => Promise.resolve(app.fetch(new Request(i, init)));
  const query = async (sql: string, params: unknown[]) => {
    const res = await fetchVia("http://dx.test/api/sql", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ sql, params }),
    });
    if (res.status === 404) return [];
    return z.object({ rows: z.array(z.record(z.string(), z.unknown())) }).parse(await res.json()).rows;
  };
  return {
    subject: new DxFakeSink({ baseUrl: "http://dx.test", token: TOKEN, fetch: fetchVia }),
    cleanup: async () => {},
    readStatus: async (id) => {
      const rows = await query("SELECT status FROM custom.factory_tasks WHERE task_id = $1", [id]);
      const s = rows[0]?.status;
      return typeof s === "string" ? s : null;
    },
    countTasks: async () => (await query("SELECT task_id FROM custom.factory_tasks", [])).length,
  };
});
