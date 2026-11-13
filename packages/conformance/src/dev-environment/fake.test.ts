import { InMemoryDevEnvironment } from "./fake.js";
import { describeDevEnvironmentConformance } from "./suite.js";

describeDevEnvironmentConformance("InMemoryDevEnvironment (fake)", async () => ({
  subject: new InMemoryDevEnvironment(),
  repo: { host: "github", owner: "acme", name: "app" },
  cleanup: async () => {},
}));
