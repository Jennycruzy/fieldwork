import { describe, expect, it } from "vitest";
import { HMEM, feedback, recall, remember } from "@fieldwork/hmem";

// A fixed clock keeps scores reproducible.
const clock = () => 1_792_800_000_000;

describe("source memory on H-MEM", () => {
  it("recalls what an earlier run learned about a dataset, with provenance", () => {
    const mem = new HMEM({ clock, actor: "fieldwork" });
    remember(mem, {
      kind: "choice",
      runId: "r_20261024_58bb8f",
      content: 'For "adult asthma prevalence by census tract" in Montgomery, AL, Fieldwork chose the dataset "PLACES: Census Tract Data (GIS Friendly Format), 2025 release": newest CDC PLACES tract release.',
      confidence: 0.8,
      refs: ["https://data.cdc.gov/resource/yjkw-uj5s.json"],
      datasetTitle: "PLACES: Census Tract Data (GIS Friendly Format), 2025 release",
    });
    remember(mem, { kind: "quality", runId: "r_20261024_58bb8f", content: 'Dataset "Code Violations" contains a test record with CaseStatus = DEBUG_TEST; exclude it.', confidence: 0.9 });

    const got = recall(mem, "adult asthma rate by census tract dataset", { kinds: ["choice"] });
    expect(got[0]?.content).toContain("PLACES");
    expect(got[0]?.source).toBe("fieldwork:run:r_20261024_58bb8f");
    // H-MEM's trust ledger recorded the create and the read.
    const actions = mem.ledger.history(got[0]!.id).map((e) => e.action);
    expect(actions).toContain("create");
    expect(actions).toContain("read");
  });

  it("raises confidence when a recalled memory helped, lowers it when it misled", () => {
    const mem = new HMEM({ clock });
    const r = remember(mem, { kind: "wiring", runId: "r1", content: 'Dataset "Code Violations" wires into Zetaris as arcgis_features with Year filter.', confidence: 0.7 });
    feedback(mem, [r.id], "helpful");
    expect(mem.store.get(r.id)!.confidence).toBeCloseTo(0.75, 5);
    feedback(mem, [r.id], "wrong");
    expect(mem.store.get(r.id)!.confidence).toBeCloseTo(0.55, 5);
  });
});
