import { describeScorerConformance } from "./suite.js";
import { EventCountScorer } from "./fake.js";

describeScorerConformance("EventCountScorer (fake)", () => new EventCountScorer("status_changed"));
