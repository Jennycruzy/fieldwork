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

it("checks every tract in a plural tie against the ranked column",()=>{
 const headers=["name","count"];const rows=[["Census Tract 11","1125"],["Census Tract 25","955"],["Census Tract 12","818"],["Census Tract 16","700"],["Census Tract 17","650"],["Census Tract 22","600"],["Census Tract 3","591"],["Census Tract 24","515"],["Census Tract 4","515"]];
 expect(checkDraft(["Census Tracts 24 and 4 each had 515 violations, sharing the 8th rank."],headers,rows).ok).toBe(true);
 expect(checkDraft(["Census Tracts 24 and 4 each had 515 violations, sharing the 7th rank."],headers,rows).ok).toBe(false);
 expect(checkDraft(["Census Tracts 24 and 3 each had 515 violations, sharing the 8th rank."],headers,rows).ok).toBe(false);
});

it("recognizes lowercase tract names and Unicode rank punctuation",()=>{
 const rows=[["Census Tract 12","14"],["Census Tract 10","13.7"]];
 expect(checkDraft(["tract 12 has the highest rate (14)."],["name","rate"],rows).ok).toBe(true);
 expect(checkDraft(["tract 10 has the 2nd‑highest rate (13.7)."],["name","rate"],rows).ok).toBe(true);
});
it("allows an explicit denial of causation while rejecting a positive causal claim",()=>{
 expect(checkDraft(["The correlation does not establish that violations cause higher prevalence."],["name","value"],[["A","1"]]).ok).toBe(true);
 expect(checkDraft(["Violations cause prevalence, but not in every place."],["name","value"],[["A","1"]]).ok).toBe(false);
});

it("a negation cannot excuse a later causal claim",()=>{
 expect(checkDraft(["This does not establish a relationship. Code violations cause hypertension."],["name","count"],[["Census Tract 1","100"]]).ok).toBe(false);
});

// Original wording and complete rows from the recorded 311 and shelter answers.
import { readFileSync } from "node:fs";
function recorded(id: string) {
 return JSON.parse(readFileSync(new URL(`../../../evidence/runs/r_20261024_${id}.run.json`,import.meta.url),"utf8")).answer;
}
it("resolves each 311 rank clause to the tract named in that clause",()=>{
 const a=recorded("ab8c31");
 expect(checkDraft([a.answer.headline,...a.answer.points],a.headers,a.rows,a.sources.map((s:{title:string})=>s.title)).ok).toBe(true);
 expect(checkDraft(["Census Tract 25 had the most requests with 1,071, followed by Tract 1 (1,419)."],a.headers,a.rows).ok).toBe(false);
 expect(checkDraft(["Tract 1 had the most requests with 1,419, and Tract 25 ranked first with 1,071."],a.headers,a.rows).ok).toBe(false);
});
it("recognizes shelter tract lists including the Oxford comma",()=>{
 const a=recorded("362ff8");
 for(const text of ["Census Tracts 22.01, 33.03 and 54.03 contain shelters.","Census Tracts 18, 22.01, 33.03, 54.03, 54.12, and 56.05 each contain one shelter."])
  expect(checkDraft([text],a.headers,a.rows).ok).toBe(true);
 expect(checkDraft(["Tract 56.05 has 54.03 shelters."],a.headers,a.rows).ok).toBe(false);
});

it("verifies sums, differences and percent changes from recorded monthly cells",()=>{
 const a=recorded("e64b68");
 const cells=a.rows.map((r:string[])=>Number(r[1]));
 const sum=cells.reduce((x:number,y:number)=>x+y,0);
 const difference=cells[6]-cells[1],change=difference/cells[1]*100;
 for(const text of [`The published months total ${sum} calls.`,`Calls increased by ${difference} from February to July.`,`Calls increased by ${change.toFixed(2)}%.`])
  expect(checkDraft([text],a.headers,a.rows).missingNumbers).toEqual([]);
 expect(checkDraft(["Calls increased by 32.617493%."],a.headers,a.rows).ok).toBe(false);
 expect(checkDraft(["The monthly total was 99999999 calls."],a.headers,a.rows).ok).toBe(false);
 expect(checkDraft(["A derived change is 11.11%."],["month","count"],[["1","0"],["2",null]]).ok).toBe(false);
});

it("uses the stated precision and does not derive across unrelated columns",()=>{
 expect(checkDraft(["The change is 33.33%."],["month","calls"],[["Jan","300"],["Feb","400"]]).ok).toBe(true);
 expect(checkDraft(["The change is 33.30%."],["month","calls"],[["Jan","300"],["Feb","400"]]).ok).toBe(false);
 expect(checkDraft(["The change is 12345."],["name","calls","population"],[["A","12000","345"],["B","56000","789"]]).ok).toBe(false);
});

import {supportedDraft} from "../src/checks.js";
it("recognizes calendar-month names in the recorded normalized monthly result",()=>{
 const a=recorded25("617a2f");
 expect(checkDraft(["The highest monthly count was 2,521 in June","The lowest monthly count (668 in February)"],a.headers,a.rows).ok).toBe(true);
});
it("unqualified ordinal ranks follow the recorded ascending score query",()=>{
 const a=recorded25("617926");
 expect(checkDraft(["Tract 54.13 ranks second with an average score of 92.0 across 2 establishments"],a.headers,a.rows).ok).toBe(true);
 expect(checkDraft(["Tract 54.13 ranks first with an average score of 92.0 across 2 establishments"],a.headers,a.rows).ok).toBe(false);
});
it("verifies tract identifiers as metadata while retaining the universal-pattern check",()=>{
 const a=recorded25("a5f032");
 expect(checkDraft(["Geoid codes are provided for each tract; the numeric suffix (e.g., 22.01) reflects the census tract numbering used by the source."],a.headers,a.rows).ok).toBe(true);
 expect(checkDraft(["Geoid codes are provided for each tract; the numeric suffix (e.g., 99.99) reflects the census tract numbering."],a.headers,a.rows).ok).toBe(false);
});
it("omits an unsupported headline as well as unsupported points",()=>{
 const a=recorded25("3a4e21"),facts=a.checks.map((c:{detail:string})=>c.detail);
 expect(a.rows).toHaveLength(48);
 const result=supportedDraft(a.answer,a.headers,a.rows,facts);
 expect(result.headline).not.toBe(a.answer.headline);
 expect(checkDraft([result.headline,...result.points,result.how_sure,...result.caveats],a.headers,a.rows,facts).ok).toBe(true);
});
function recorded25(id:string){return JSON.parse(readFileSync(new URL(`../../../evidence/runs/r_20261025_${id}.run.json`,import.meta.url),"utf8")).answer;}

it("metadata does not excuse an unsupported universal relationship",()=>{
 const a=recorded25("a5f032");
 expect(checkDraft(["Geoid codes are provided for each tract; higher requests consistently mean higher health burden."],a.headers,a.rows).ok).toBe(false);
});

it("a named shelter row cannot borrow a small count or identifier digits",()=>{
 const a=recorded25("fe9fd0");
 expect(checkDraft(["Tract 22.01 has 4 listed shelters."],a.headers,a.rows).ok).toBe(false);
 expect(checkDraft(["Tract 22.01 has 1 listed shelter."],a.headers,a.rows).ok).toBe(true);
 expect(checkDraft(["Tract 22.01 has 6 shelters in total across the returned tracts."],a.headers,a.rows).ok).toBe(true);
 expect(checkDraft(["Tract 22.01 has 1101002201 listed shelters."],a.headers,a.rows).ok).toBe(false);
});
it("a tract claim cannot borrow another tract's numeric measure",()=>{
 const a=recorded25("a5f032");
 expect(checkDraft(["Tract 25 had 1,419 requests."],a.headers,a.rows).ok).toBe(false);
 expect(checkDraft(["Tract 25 had 1,071 requests."],a.headers,a.rows).ok).toBe(true);
});

it("one singular tract prefix covers a complete list of recorded shelter identifiers",()=>{
 const a=recorded25("fe9fd0");
 for(const text of [
  "Census Tract 18, 22.01, 33.03, 54.03, 54.12 and 56.05",
  "The six tracts with a shelter are Census Tract 18, 22.01, 33.03, 54.03, 54.12 and 56.05.",
  "Census Tract 18, 22.01, 33.03, 54.03, 54.12, and 56.05 each contain 1 shelter."
 ])expect(checkDraft([text],a.headers,a.rows).ok).toBe(true);
 expect(checkDraft(["Census Tract 18, 22.01, 33.03 and 56.05 each contain 4 shelters."],a.headers,a.rows).ok).toBe(false);
});
