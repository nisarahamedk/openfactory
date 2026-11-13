import { describeMetricsSinkConformance } from "./suite.js";
import { InMemoryMetricsSink } from "./fake.js";

describeMetricsSinkConformance("InMemoryMetricsSink (fake)", async () => {
  const sink = new InMemoryMetricsSink();
  return {
    subject: sink,
    cleanup: async () => {},
    readStatus: async (id) => sink.rows.get(id)?.status ?? null,
    countTasks: async () => sink.rows.size,
  };
});
