import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { AnswerSchema, checkDraft, finalizeDraft } from "@fieldwork/core";
import { ModelChain, type Provider, type ChatRequest } from "@fieldwork/llm";
import { writerSchema } from "../src/agents/writer.js";
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
  const report = JSON.parse(readFileSync("evidence/evaluation.json", "utf8"));
  for (const question of ["Q03", "Q20"]) {
    const result = report.latest.results.find((r: { question_id: string }) => r.question_id === question);
    const recorded = JSON.parse(readFileSync("evidence/runs/" + result.run_id + ".run.json", "utf8")).answer
      .answer;
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
  "internal answer wording enters repair: %s",
  (point) => {
    expect(writerSchema(sources).safeParse({ ...valid, points: [point] }).success).toBe(false);
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
