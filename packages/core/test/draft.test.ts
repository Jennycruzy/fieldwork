import { describe, expect, it } from "vitest";
import { checkDraft, claimedRank } from "@fieldwork/core";

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
    expect(r.orderProblems[0]).toContain("rank 2, but in the rows it is rank 3");
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

describe("ranking words (live run r_20261024_72d843)", () => {
  it("catches 'ties for third-highest' when the rows put the tract 4th (tied with Tract 24)", () => {
    const r = checkDraft(["Census Tract 56.14 ties for third-highest asthma rate at 13.1% but has only 44 violations"], headers, rows);
    expect(r.ok).toBe(false);
    expect(r.orderProblems[0]).toContain("rank 4");
  });

  it("accepts the correct statements from the same run", () => {
    const ok = checkDraft(
      ["Census Tract 12 leads with 14.0% adult asthma rate and 818 code violations", "Census Tract 10 follows with 13.7% asthma rate and 265 violations", "Census Tract 24 ties for fourth at 13.1%"],
      headers,
      rows,
    );
    expect(ok.orderProblems).toEqual([]);
  });

  it("reads ordinal words", () => {
    expect(claimedRank("ranks fifth")).toBe(5);
    expect(claimedRank("is 3rd")).toBe(3);
    expect(claimedRank("has the highest rate")).toBe(1);
    expect(claimedRank("has 13.2% asthma rate")).toBeUndefined();
  });
});
