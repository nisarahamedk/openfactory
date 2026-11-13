import { describeScorerConformance } from "@openfactory/conformance";
import { factScorers } from "./facts.js";

for (const s of factScorers) describeScorerConformance(s.name, () => s);
