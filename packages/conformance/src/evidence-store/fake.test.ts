import { describeEvidenceStoreConformance } from "./suite.js";
import { InMemoryEvidenceStore } from "./fake.js";

describeEvidenceStoreConformance("InMemoryEvidenceStore (fake)", async () => ({ subject: new InMemoryEvidenceStore(), cleanup: async () => {} }));
