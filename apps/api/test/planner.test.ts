import { test, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { plan } from "../src/agents/planner.js";
import type { Ctx } from "../src/agents/context.js";
for (const id of ["ee688c", "8808f6"])
  test(`unknown public facilities go to discovery after the recorded refusal ${id}`, async () => {
    const r = JSON.parse(readFileSync(`evidence/runs/r_20261024_${id}.run.json`, "utf8"));
    const refusal = r.answer.plan;
    const accepted = {
      ...refusal,
      in_scope: true,
      out_of_scope_reason: null,
      scope_limit: null,
      measures: [{ id: "m1", describe: r.question, kind: "city_records", search_terms: ["pharmacy"] }],
    };
    const json = vi
      .fn()
      .mockResolvedValueOnce({ value: structuredClone(refusal) })
      .mockResolvedValueOnce({ value: accepted });
    const ctx = {
      cfg: { place: { name: "Montgomery, AL" } },
      today: new Date("2026-10-25"),
      models: { planner: { json } },
    } as unknown as Ctx;
    const result = await plan(ctx, r.question);
    expect(result.in_scope).toBe(true);
    expect(result.measures[0]?.search_terms).toContain("pharmacy");
    expect(json).toHaveBeenCalledTimes(2);
  });
test("explicit public-data scope limits remain refusals", async () => {
  const value = {
    in_scope: false,
    scope_limit: "personal",
    out_of_scope_reason: "Personal diagnosis",
    geography: "city",
    measures: [],
    output: "list",
  };
  const ctx = {
    cfg: { place: { name: "Montgomery, AL" } },
    today: new Date(),
    models: { planner: { json: vi.fn(async () => ({ value })) } },
  } as unknown as Ctx;
  expect((await plan(ctx, "Diagnose my chest pain")).in_scope).toBe(false);
});

test("unadjusted event changes preserve annual counts instead of adding an unrequested population series", async () => {
  for (const [series, from, to, direction] of [
    ["Service Requests", 2022, 2023, "increase"],
    ["Permit Records", 2020, 2024, "decrease"],
  ] as const) {
    const value = {
      in_scope: true,
      geography: "tract",
      output: "ranking",
      years: { from, to },
      measures: [
        { id: "events", kind: "city_records", describe: series, search_terms: [series] },
        {
          id: "pop",
          kind: "health_estimate",
          describe: "total resident population for rate denominators",
          search_terms: ["population"],
        },
      ],
      analysis: {
        basis: "rates",
        denominator: "residents",
        relationship: false,
        rank_measure: "biggest " + direction + " in event rates",
        reason: "Population adjustment",
      },
    };
    const ctx = {
      cfg: { place: { name: "Example" } },
      today: new Date("2026-10-26"),
      models: { planner: { json: async () => ({ value }) } },
    } as unknown as Ctx;
    const result = await plan(
      ctx,
      "Which areas had the biggest " + direction + " in " + series + " from " + from + " to " + to + "?",
    );
    expect(result.measures).toHaveLength(1);
    expect(result.analysis?.basis).toBe("counts");
    expect(result.analysis?.denominator).toBe("none");
    expect(result.analysis?.rank_measure).toBe(
      "count change " + (direction === "decrease" ? "ascending" : "descending"),
    );
  }
});
test("an explicitly requested rate change retains its population denominator", async () => {
  const value = {
    in_scope: true,
    geography: "tract",
    output: "ranking",
    years: { from: 2022, to: 2023 },
    measures: [
      { id: "events", kind: "city_records", describe: "Permit records", search_terms: ["permits"] },
      {
        id: "pop",
        kind: "health_estimate",
        describe: "total resident population",
        search_terms: ["population"],
      },
    ],
    analysis: {
      basis: "rates",
      denominator: "residents",
      relationship: false,
      rank_measure: "biggest increase in permit rates",
      reason: "Requested per-resident rate",
    },
  };
  const ctx = {
    cfg: { place: { name: "Example" } },
    today: new Date("2026-10-26"),
    models: { planner: { json: async () => ({ value }) } },
  } as unknown as Ctx;
  const result = await plan(
    ctx,
    "Which areas had the biggest increase in permits per 1,000 residents from 2022 to 2023?",
  );
  expect(result.measures).toHaveLength(2);
  expect(result.analysis?.basis).toBe("rates");
  expect(result.analysis?.denominator).toBe("residents");
});
