import { describe, expect, it } from "vitest";
import { checkDraft } from "@fieldwork/core";

// Result rows and Writer text from live run r_20261024_a9ca4a (24 Oct 2026).
const headers = ["name", "asthma_rate", "population", "code_violations_2025"];
const rows = [
  ["Census Tract 12", "14.0", "1455.0", "818"],
  ["Census Tract 10", "13.7", "1200.0", "265"],
  ["Census Tract 3", "13.2", "1261.0", "702"],
  ["Census Tract 56.14", "13.1", "2808.0", "44"],
  ["Census Tract 24", "13.1", "1758.0", "515"],
];

describe("checkDraft", () => {
  it("passes numbers that are in the rows", () => {
    const r = checkDraft(["Census Tract 12 has the highest adult asthma rate at 14.0%, with 818 code violations in 2025"], headers, rows);
    expect(r.ok).toBe(true);
  });

  it("catches the live run's ordering slip: Tract 3 does not follow Tract 12", () => {
    const r = checkDraft(["Census Tract 3 follows with 13.2% asthma rate and 702 code violations"], headers, rows);
    expect(r.ok).toBe(false);
    expect(r.orderProblems[0]).toContain("Census Tract 10");
  });

  it("catches a number that is not in the rows", () => {
    const r = checkDraft(["Census Tract 12 has 900 code violations"], headers, rows);
    expect(r.missingNumbers).toEqual(["900"]);
  });

  it("accepts thousands separators", () => {
    const big = [["Census Tract 11", "12.7", "2684.0", "1125"]];
    expect(checkDraft(["Census Tract 11 had 1,125 violations"], headers, big).ok).toBe(true);
  });
});
