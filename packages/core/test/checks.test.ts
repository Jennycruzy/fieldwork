import { describe, expect, it } from "vitest";
import { looksLikeTestValue, partialYear, PlanSchema, runChecks } from "@fieldwork/core";

describe("runChecks", () => {
  it("fails a weak bridge match and passes a strong one", () => {
    const weak = runChecks({ bridge: { matched: 80, total: 100, unmatched: 20, invalid: 0 }, sourceCounts: [], resultRows: 5 });
    expect(weak.find((c) => c.id === "bridge_match")?.ok).toBe(false);
    const strong = runChecks({ bridge: { matched: 98, total: 100, unmatched: 1, invalid: 1 }, sourceCounts: [], resultRows: 5 });
    expect(strong.find((c) => c.id === "bridge_match")?.ok).toBe(true);
  });

  it("compares Zetaris row counts with the source's own count", () => {
    const r = runChecks({ sourceCounts: [{ label: "cdc", source: 71, zetaris: 70, capped: false }], resultRows: 1 });
    expect(r.find((c) => c.id === "rows_cdc")?.ok).toBe(false);
  });

  it("flags small groups", () => {
    const r = runChecks({ sourceCounts: [], resultRows: 3, minGroupSize: 12 });
    expect(r.find((c) => c.id === "sample_size")?.ok).toBe(false);
  });
});

describe("data-quality rules", () => {
  it("labels the current year as partial", () => {
    expect(partialYear({ from: 2023, to: 2026 }, new Date("2026-10-24T12:00:00Z"))).toContain("2026 is still in progress");
    expect(partialYear({ from: 2023, to: 2025 }, new Date("2026-10-24T12:00:00Z"))).toBeUndefined();
  });

  it("spots test values like DEBUG_TEST (seen in Montgomery's code violations)", () => {
    expect(looksLikeTestValue("DEBUG_TEST")).toBe(true);
    expect(looksLikeTestValue("CLOSED")).toBe(false);
    expect(looksLikeTestValue("NUISANCE")).toBe(false);
  });
});

describe("PlanSchema", () => {
  it("accepts a Planner answer shape", () => {
    const ok = PlanSchema.safeParse({
      in_scope: true,
      geography: "tract",
      years: { from: 2025, to: 2025 },
      measures: [{ id: "m1", describe: "adult asthma", kind: "health_estimate", search_terms: ["asthma census tract"] }],
      output: "ranking",
    });
    expect(ok.success).toBe(true);
  });
});
