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

  it("reads a LEFT JOIN row with an empty cell instead of crashing (live run 24 Oct)", () => {
    const withNull = [...rows, ["Census Tract 54.06", "9.1", null]];
    expect(checkDraft(["Census Tract 12 has the highest adult asthma rate at 14.0%, with 818 code violations in 2025"], headers, withNull).ok).toBe(true);
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

describe("live runs r_20261024_430abd and r_20261024_7d973f", () => {
  it("catches the invented 'Eleven tracts share the third-highest rate' (names no row)", () => {
    const r = checkDraft(["Eleven tracts share the third-highest rate of 13.2%, all with population counts ranging from 1,261 to 3,754"], headers, rows);
    expect(r.ok).toBe(false);
  });

  it("treats a share and its percent as the same figure", () => {
    const h = ["name", "code_violations_2025", "population", "high_bp_share"];
    const rr = [["Census Tract 11", "1125", "2684.0", "0.601"], ["Census Tract 25", "955", "2315.0", "0.523"]];
    const r = checkDraft(["Census Tract 11 had 1,125 code violations, and 60.1% of adults there have high blood pressure.", "52.3% of adults in Census Tract 25 have high blood pressure"], h, rr);
    expect(r.missingNumbers).toEqual([]);
  });

  it("does not read a tract's name as a value claim", () => {
    const h = ["name", "n"];
    const rr = [["Census Tract 11", "1125"]];
    expect(checkDraft(["Tract 11 had 1,125 violations"], h, rr).ok).toBe(true);
    expect(checkDraft(["Tract 11 had 1,126 violations"], h, rr).ok).toBe(false);
  });
});

describe("live run r_20261024_72540e", () => {
  it("accepts numbers the run's own checks established, and small counts", () => {
    const h = ["name", "n", "diabetes_pct"];
    const rr = [["Census Tract 11", "1125", "27.6"], ["Census Tract 25", "955", "22.5"]];
    const facts = ["15,103 of 15,439 located records fell inside a tract (97.8%)"];
    const r = checkDraft(["15,103 of 15,439 records (97.8%) were placed in tracts; the top 5 tracts follow"], h, rr, facts);
    expect(r.missingNumbers).toEqual([]);
  });
});

// Rows from live run r_20261024_217d18 (sorted by violations per 1,000; Tract 11 has the higher blood pressure rate).
describe("checkDraft on a correlation answer", () => {
  const h = ["name", "population", "code_violations", "violations_per_1000_adults", "high_bp_prev", "pearson_corr"];
  const r = [
    ["Census Tract 12", "1455.0", "939.0", "645.360824742268", "59.2", "0.640893647462182"],
    ["Census Tract 11", "2684.0", "1633.0", "608.4202682563339", "60.1", "0.640893647462182"],
    ["Census Tract 22.02", "884.0", "474.0", "536.1990950226244", "57.8", "0.640893647462182"],
    ["Census Tract 3", "1261.0", "591.0", "468.67565424266456", "55.7", "0.640893647462182"],
    ["Census Tract 7", "997.0", "366.0", "367.1", "41.2", "0.640893647462182"],
  ];

  it("catches the live slip: Tract 12 is not highest in blood pressure (Tract 11 is)", () => {
    const d = checkDraft(["Census Tract 12 had the highest violations per 1,000 adults at 645.4 and the highest high blood pressure rate at 59.2%"], h, r);
    expect(d.ok).toBe(false);
    expect(d.orderProblems[0]).toContain("rank 2 by high_bp_prev");
  });

  it("accepts correct ranks in two different columns", () => {
    expect(checkDraft(["Census Tract 11 ranked second in violations per 1,000 adults at 608.4 and has the highest high blood pressure rate at 60.1%"], h, r).ok).toBe(true);
  });

  it("rejects claims that the pattern holds in every row", () => {
    expect(checkDraft(["The pattern holds across the full list: higher violations correspond with higher blood pressure in every row"], h, r).ok).toBe(false);
    expect(checkDraft(["Tracts with more code violations consistently have higher blood pressure rates, with a correlation of 0.641"], h, r).ok).toBe(false);
    expect(checkDraft(["Tracts with more code violations tend to have higher blood pressure rates (correlation 0.641)"], h, r).ok).toBe(true);
  });
});
