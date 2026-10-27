import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { AnswerSchema, checkDraft, finalizeDraft } from "@fieldwork/core";
import { ModelChain, type Provider, type ChatRequest } from "@fieldwork/llm";
import { write, writerSchema, correlationFigures } from "../src/agents/writer.js";
import type { Wired } from "../src/agents/wirer.js";

const sources = [
  {
    fields: ["totalpopulation", "casthma_crudeprev"],
    fieldDefinitions: { totalpopulation: "Total population of Census 2020" },
  },
] as Pick<Wired, "fields" | "fieldDefinitions">[];
const valid = {
  headline: "A descriptive comparison.",
  points: ["The comparison includes all eligible tracts."],
  how_sure: "The comparison describes the published records.",
  caveats: ["Asthma is a model-based health estimate; facilities are registry counts."],
};

test.each(["", "   ", "\n\t"])("blank confidence text fails the answer schema: %j", (how_sure) => {
  expect(AnswerSchema.safeParse({ ...valid, how_sure }).success).toBe(false);
});

test("blank confidence is repaired through the real model chain", async () => {
  const calls: ChatRequest[] = [];
  const provider: Provider = {
    id: "scripted",
    async chat(req) {
      calls.push(req);
      return {
        text: JSON.stringify({ ...valid, how_sure: calls.length === 1 ? "   " : valid.how_sure }),
        provider: "scripted",
        modelRequested: req.model,
        modelServed: req.model,
        tokensIn: 1,
        tokensOut: 1,
        ms: 1,
      };
    },
  };
  const result = await new ModelChain([{ provider, model: "test:free" }], {
    sequentialJsonRepair: true,
  }).json([], writerSchema(sources));
  expect(calls).toHaveLength(2);
  expect(calls[1]!.messages.at(-1)!.content).toContain("how_sure");
  expect(result.value.how_sure).toBe(valid.how_sure);
});

test("recorded mixed-source errors fail wording validation while supported findings pass", () => {
  // Batch 12's recorded Q03 and Q20 drafts, which carried the mixed-source wording errors.
  for (const runId of ["r_20261027_91258e", "r_20261027_8dd81a"]) {
    const recorded = JSON.parse(readFileSync("evidence/runs/" + runId + ".run.json", "utf8")).answer.answer;
    expect(writerSchema(sources).safeParse(recorded).success).toBe(false);
  }
  expect(writerSchema(sources).safeParse(valid).success).toBe(true);
  expect(
    writerSchema(sources).safeParse({
      ...valid,
      caveats: ["Population is Census 2020, supplied in the CDC PLACES 2025 release."],
    }).success,
  ).toBe(true);
  expect(
    writerSchema(sources).safeParse({ ...valid, caveats: ["Facilities are not model-based estimates."] })
      .success,
  ).toBe(true);
});

test.each(["All checks passed.", "No subsample truncation.", "Every measure column has real values."])(
  "internal answer wording is omitted without losing findings: %s",
  (point) => {
    const omitted: string[] = [];
    const result = writerSchema(sources, (sentence) => omitted.push(sentence)).parse({
      ...valid,
      points: ["The comparison includes all eligible tracts.", point],
    });
    expect(result.points).toEqual(["The comparison includes all eligible tracts."]);
    expect(omitted).toEqual([point]);
  },
);

test.each([
  "Both variables are model-based estimates from survey and registry data.",
  "Facility counts are model-based estimates.",
  "The answer uses 2025 census-tract population data.",
  "Population and violation counts are from the 2025 datasets.",
])("unsupported source wording enters repair: %s", (caveat) => {
  expect(writerSchema(sources).safeParse({ ...valid, caveats: [caveat] }).success).toBe(false);
});

test("sentence filtering preserves nonempty confidence after rejecting unsupported numbers", () => {
  const result = finalizeDraft(
    { ...valid, how_sure: "There are 999 records." },
    ["tract_name", "count"],
    [["Area", "2"]],
    [],
  );
  expect(AnswerSchema.safeParse(result.draft).success).toBe(true);
  expect(result.removed).toContain("There are 999 records.");
  expect(checkDraft([result.draft.how_sure], ["tract_name", "count"], [["Area", "2"]]).ok).toBe(true);
});

test("population-only sources cannot be described as model-based health estimates", () => {
  const population = [
    { fields: ["totalpopulation"], fieldDefinitions: { totalpopulation: "Total population of Census 2020" } },
  ];
  expect(
    writerSchema(population).safeParse({
      ...valid,
      caveats: [],
      how_sure: "The PLACES release provides the population figures and is a model-based estimate.",
    }).success,
  ).toBe(false);
  expect(
    writerSchema(population).safeParse({
      ...valid,
      caveats: [],
      how_sure: "These are Census population totals supplied by CDC PLACES.",
    }).success,
  ).toBe(true);
});

test("internal sentences are omitted while substantive facts in the same point survive", () => {
  const result = writerSchema(sources).parse({
    ...valid,
    points: ["The correlation is -0.08. Every measure column has real values and all checks passed."],
  });
  expect(result.points).toEqual(["The correlation is -0.08."]);
});

test.each([
  "The comparison uses facility counts and model-based adult asthma prevalence.",
  "Model-based asthma estimates from CDC are compared with EPA facility counts.",
  "Asthma prevalence is model-based, while facilities are registry counts.",
  "Unlike model-based health estimates, facility listings are registry counts.",
])("mixed-source comparisons do not label registry counts model-based: %s", (how_sure) => {
  expect(writerSchema(sources).safeParse({ ...valid, how_sure }).success).toBe(true);
});
test("source-type repair names the rejected clause", () => {
  const clause = "Facility counts are model-based estimates.";
  const result = writerSchema(sources).safeParse({ ...valid, caveats: [clause] });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.message).toContain("Facility counts are model-based estimates");
});

test("correlation-only wording cannot convert a coefficient into a per-unit effect", () => {
  const text =
    "Each additional facility per 1,000 residents is associated with a 0.08 percentage point decrease in adult asthma prevalence.";
  const omitted: string[] = [];
  const answer = writerSchema(sources, (s) => omitted.push(s), true).parse({
    ...valid,
    points: ["The correlation is -0.08 across 71 tracts.", text],
  });
  expect(answer.points).toEqual(["The correlation is -0.08 across 71 tracts."]);
  expect(omitted).toEqual([text]);
  expect(writerSchema(sources, undefined, false).parse({ ...valid, points: [text] }).points).toEqual([text]);
});
test("correlation prompts supply the coefficient and paired cohort, without unrelated extremes or rankings", () => {
  const facts = correlationFigures(
    ["tract_name", "facility_rate", "asthma_prevalence", "correlation", "paired_tracts"],
    [["Area", "249.6", "14", "-0.08", "71"]],
  );
  expect(facts.statistics).toEqual([
    { field: "correlation", value: "-0.08" },
    { field: "paired_tracts", value: "71" },
  ]);
  expect(JSON.stringify(facts)).not.toContain("249.6");
  expect(facts.interpretation).toContain("not a slope");
});
test("omission cannot leave confidence empty or internal wording in caveats", () => {
  const answer = writerSchema(sources, undefined, true).parse({
    ...valid,
    how_sure: "Each additional unit is associated with a decrease.",
    caveats: ["No subsample truncation was applied."],
  });
  expect(AnswerSchema.safeParse(answer).success).toBe(true);
  expect(answer.caveats).toEqual([]);
  expect(answer.how_sure).not.toContain("additional");
});

test("release years cannot be invented as a geography vintage", () => {
  const answer = writerSchema(sources).parse({
    ...valid,
    caveats: ["Model-based asthma estimate; 2023 underlying data applied to 2025 geography."],
  });
  expect(answer.caveats).toEqual([]);
});

test("missing-month source evidence cannot be described as complete annual coverage", () => {
  const text = "Code violations data comes from city registry records with complete annual 2025 coverage.";
  const answer = writerSchema(sources, undefined, false, true).parse({
    ...valid,
    how_sure: text,
    caveats: ["Complete annual coverage is not established; absent months are not confirmed zeros."],
  });
  expect(answer.how_sure).not.toContain("complete annual");
  expect(answer.caveats).toContain(
    "Complete annual coverage is not established; absent months are not confirmed zeros.",
  );
  expect(writerSchema(sources).parse({ ...valid, how_sure: text }).how_sure).toBe(text);
});
test("Writer always appends the source's exact missing-month caveat despite any other coverage wording", async () => {
  const detail =
    "City records: monthly coverage in the requested year. Only 11 calendar months contain records; 1 month has no source rows. Complete annual coverage is not established; absent months are not confirmed zeros.";
  const provider: Provider = {
    id: "scripted",
    async chat(req) {
      return {
        text: JSON.stringify({
          headline: "The table describes city records.",
          points: ["There is 1 record."],
          how_sure: "City records have complete annual 2025 coverage.",
          caveats: [],
        }),
        provider: "scripted",
        modelRequested: req.model,
        modelServed: req.model,
        tokensIn: 1,
        tokensOut: 1,
        ms: 1,
      };
    },
  };
  const model = new ModelChain([{ provider, model: "test:free" }], { sequentialJsonRepair: true });
  const ctx = {
    cfg: { place: { region: "Example" } },
    models: { writer: model },
    trace: { log: async () => {} },
  } as any;
  const answer = await write(
    ctx,
    "Show city records",
    { in_scope: true, geography: "tract", output: "list", measures: [] },
    [],
    {
      sql: "SELECT 1",
      result: { headers: ["name", "count"], rows: [["Area", "1"]], total: 1, ms: 0, wallMs: 0 },
    },
    [{ id: "source_dates_city", ok: true, detail }],
    1,
  );
  expect(answer.caveats).toContain(
    "Only 11 calendar months contain records; 1 month has no source rows. Complete annual coverage is not established; absent months are not confirmed zeros.",
  );
  expect(answer.how_sure).not.toContain("complete annual");
  expect(
    checkDraft([answer.how_sure, ...answer.caveats], ["name", "count"], [["Area", "1"]], [detail]).ok,
  ).toBe(true);
});

test("release year cannot be asserted as the underlying data vintage", () => {
  const answer = writerSchema(sources).parse({
    ...valid,
    caveats: [
      "The CDC PLACES release year (2025) reflects the data vintage; underlying population estimates are Census 2020.",
    ],
  });
  expect(answer.caveats).toEqual([]);
});
