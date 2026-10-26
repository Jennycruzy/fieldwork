import { test, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { write } from "../src/agents/writer.js";
import { monthlySummarySql } from "../src/agents/joiner.js";
import { checkDraft } from "@fieldwork/core";
import type { Wired } from "../src/agents/wirer.js";
import type { Ctx } from "../src/agents/context.js";
const run = JSON.parse(readFileSync("evidence/runs/r_20261025_aac44f.run.json", "utf8"));
test("weighted call metadata sets the monthly unit and always supplies its caveat", async () => {
  const a = run.answer;
  const wired = [
    {
      ...a.sources[0],
      label: "m1_city",
      where: a.sources[0].filter,
      zetarisCount: a.sources[0].records,
      normalized: true,
      valueKind: "count",
      valueField: "Call_Count_By_Origin",
    },
  ] as Wired[];
  const json = vi.fn(async () => ({ value: { ...structuredClone(a.answer), caveats: [] } }));
  const ctx = { models: { writer: { json } }, trace: { log: vi.fn() } } as unknown as Ctx;
  const answer = await write(
    ctx,
    run.question,
    a.plan,
    wired,
    { sql: a.sql, result: { headers: a.headers, rows: a.rows, total: a.rows.length, ms: 0, wallMs: 0 } },
    a.checks,
    run.rounds,
  );
  expect(
    answer.caveats.some((s) => s.includes("call-center activity") && s.includes("not confirmed incidents")),
  ).toBe(true);
  const sql = monthlySummarySql(run.id, run.question, a.plan, wired)!;
  expect(sql).toContain("SUM(value) AS call_activity_count");
  expect(sql).not.toContain("COUNT(*)");
  expect(Number(a.rows[1][2])).toBe(44752);
  const facts = a.checks.map((c: { detail: string }) => c.detail);
  expect(checkDraft(["Montgomery 911 calls were 44,752 in February."], a.headers, a.rows, facts).ok).toBe(
    true,
  );
  expect(checkDraft(["Montgomery 911 calls were 47,828 in February."], a.headers, a.rows, facts).ok).toBe(
    false,
  );
});

import { primaryRankFacts } from "../src/agents/writer.js";
test("the recorded unequal violation counts never share a code-computed rank or tie group", () => {
  const a = JSON.parse(readFileSync("evidence/runs/r_20261025_ea19d3.run.json", "utf8")).answer;
  const facts = primaryRankFacts(a.headers, a.rows, a.plan.analysis.rank_measure);
  const one = facts.rows.find((r) => r[0] === "Census Tract 3")!,
    two = facts.rows.find((r) => r[0] === "Census Tract 17")!;
  const rank = facts.headers.indexOf("primary_rank");
  expect(one[1]).toBe("702");
  expect(two[1]).toBe("670");
  expect(one[rank]).not.toBe(two[rank]);
  expect(facts.tie_groups.some((g) => g.names.includes(one[0]!) && g.names.includes(two[0]!))).toBe(false);
});
test("the entire recorded zero-pharmacy cohort has explicit first rank and tie size", () => {
  const a = JSON.parse(readFileSync("evidence/runs/r_20261025_3a4e21.run.json", "utf8")).answer;
  const facts = primaryRankFacts(a.headers, a.rows, a.plan.analysis.rank_measure);
  const rank = facts.headers.indexOf("primary_rank"),
    size = facts.headers.indexOf("tie_size");
  expect(facts.rows).toHaveLength(48);
  expect(facts.rows.every((r) => r[rank] === "1" && r[size] === "48")).toBe(true);
  expect(facts.tie_groups[0]?.names).toHaveLength(48);
  expect(
    checkDraft(
      ["All 48 Montgomery census tracts in this result are ranked 1st."],
      a.headers,
      a.rows,
      a.checks.map((c: { detail: string }) => c.detail),
    ).ok,
  ).toBe(true);
  expect(
    checkDraft(["All 13 Montgomery census tracts in this result are ranked 1st."], a.headers, a.rows, [
      "13 days since update",
    ]).ok,
  ).toBe(false);
});
test("facility-registry answers always distinguish listings from emissions and exposure", async () => {
  const r = JSON.parse(readFileSync("evidence/runs/r_20261026_0a10d7.run.json", "utf8")),
    a = r.answer;
  const ctx = {
    models: {
      writer: {
        json: vi.fn(async () => ({
          value: {
            headline: "The result describes facility listings.",
            points: ["The rows contain tract-level counts."],
            how_sure: "The source is a facility registry.",
            caveats: [],
          },
        })),
      },
    },
    trace: { log: vi.fn() },
  } as unknown as Ctx;
  const answer = await write(
    ctx,
    r.question,
    a.plan,
    [
      { shape: "epa_facilities", title: "Facility registry", where: "county scope", zetarisCount: 100 },
    ] as Wired[],
    { sql: a.sql, result: { headers: a.headers, rows: a.rows, total: a.rows.length, ms: 0, wallMs: 0 } },
    a.checks,
    r.rounds,
  );
  expect(answer.caveats).toContain(
    "Facility registry listings are not measurements of emissions or personal exposure.",
  );
  expect(checkDraft(answer.caveats, a.headers, a.rows).ok).toBe(true);
});

test("a small-sample warning is always disclosed even if the model omits caveats", async () => {
  const a = JSON.parse(readFileSync("evidence/runs/r_20261026_f8e028.run.json", "utf8")).answer;
  const ctx = {
    models: {
      writer: {
        json: vi.fn(async () => ({
          value: {
            headline: "The table describes inspection scores.",
            points: ["Establishment counts are shown for each tract."],
            how_sure: "Latest listed inspections were compared.",
            caveats: [],
          },
        })),
      },
    },
    trace: { log: vi.fn() },
  } as unknown as Ctx;
  const answer = await write(
    ctx,
    "Lowest average latest inspection scores",
    a.plan,
    [],
    { sql: a.sql, result: { headers: a.headers, rows: a.rows, total: a.rows.length, ms: 0, wallMs: 0 } },
    a.checks,
    1,
  );
  expect(answer.caveats.some((c) => c.includes("Small establishment samples"))).toBe(true);
  expect(
    checkDraft(
      answer.caveats,
      a.headers,
      a.rows,
      a.checks.map((c: { detail: string }) => c.detail),
    ).ok,
  ).toBe(true);
});

import { computedFigures } from "../src/agents/writer.js";
import { computeFigureLedger } from "@fieldwork/core";
test("Writer prompts retain totals, cohort sizes and extreme comparisons without every adjacent ranked pair", () => {
  const headers = ["tract_name", "facility_rate", "facility_count", "totalpopulation", "geoid"];
  const rows = Array.from({ length: 71 }, (_, i) => [
    "Area " + i,
    String(i / 10),
    String(i),
    String(100 + i),
    "geo" + i,
  ]);
  const full = computeFigureLedger(headers, rows),
    compact = (
      computedFigures(headers, rows) as {
        ledger: Omit<ReturnType<typeof computeFigureLedger>[number], "labels">[];
      }
    ).ledger;
  expect(compact.length).toBeLessThan(full.length * 0.6);
  for (const f of full.filter((f) => f.kind !== "difference" && f.kind !== "percent_change"))
    expect(compact.some((c) => c.id === f.id)).toBe(true);
  expect(compact.some((f) => f.kind === "difference" && f.rows.includes(0) && f.rows.includes(70))).toBe(
    true,
  );
  expect(compact.some((f) => f.kind === "difference" && f.rows.includes(0) && f.rows.includes(1))).toBe(true);
  expect(compact.some((f) => f.kind === "difference" && f.rows.includes(30) && f.rows.includes(31))).toBe(
    false,
  );
  expect(full.some((f) => f.kind === "difference" && f.rows.includes(30) && f.rows.includes(31))).toBe(true);
});
test("monthly prompts retain every adjacent period comparison with formula and source rows", () => {
  const headers = ["year", "month", "record_count"],
    rows = Array.from({ length: 12 }, (_, i) => ["2025", String(i + 1), String(20 + i)]);
  const full = computeFigureLedger(headers, rows),
    compact = (
      computedFigures(headers, rows) as {
        ledger: Omit<ReturnType<typeof computeFigureLedger>[number], "labels">[];
      }
    ).ledger;
  expect(compact).toEqual(full.map(({ labels, ...f }) => f));
});
