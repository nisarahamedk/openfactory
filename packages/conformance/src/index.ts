/**
 * @openfactory/conformance — one test suite per abstraction, plus a faithful fake of each.
 * A provider calls `describe<Abstraction>Conformance(label, make)` from its own tests.
 * Layout: src/<abstraction>/{suite.ts, fake.ts, fake.test.ts}. Append-only exports below.
 */
export type { Subject } from "./harness.js";
export { fixtureRecord, fixtureMergedLog, standardCases, deepFreeze } from "./fixtures.js";

export { describeScorerConformance } from "./scorer/suite.js";
export { EventCountScorer } from "./scorer/fake.js";

export { describeMetricsSinkConformance, type MetricsSinkSubject } from "./metrics-sink/suite.js";
export { InMemoryMetricsSink } from "./metrics-sink/fake.js";

export { describeEvidenceStoreConformance } from "./evidence-store/suite.js";
export { InMemoryEvidenceStore } from "./evidence-store/fake.js";

export { describeWorkspaceConformance, type WorkspaceSubject, type WorkspaceConformanceOptions } from "./workspace/suite.js";
export { TempDirWorkspace } from "./workspace/fake.js";
export { makeOriginRepo } from "./workspace/origin.js";
