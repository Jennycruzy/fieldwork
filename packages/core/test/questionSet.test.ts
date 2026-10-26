import { expect, test } from "vitest";
import {
  gradeQuestion,
  checkFrozen,
  quantile,
  monthNumber,
  type RecordedAnswer,
} from "../src/questionSet.js";
const refusal = {
  id: "Q21",
  question: "Which Birmingham tracts?",
  expected: "refused-correctly",
  answer_shape: "Refuse outside Montgomery",
};
test("a scope refusal passes only for its exact frozen question and a reason", () => {
  const r = {
    id: "r",
    question: refusal.question,
    status: "refused",
    rounds: 0,
    answer: { message: "Only Montgomery is in scope" },
  };
  expect(gradeQuestion(refusal, r).passed).toBe(true);
  expect(gradeQuestion(refusal, { ...r, question: "Other question" }).passed).toBe(false);
});
test("an in-scope missing dataset is not counted as a correct refusal", () => {
  expect(
    gradeQuestion(
      { ...refusal, expected: "answered" },
      { id: "r", question: refusal.question, status: "refused", rounds: 0, answer: { message: "No source" } },
    ).passed,
  ).toBe(false);
});
test("reported success without evidence cannot pass", () => {
  expect(
    gradeQuestion(
      { ...refusal, expected: "answered" },
      { id: "r", question: refusal.question, status: "answered", rounds: 1, answer: {} },
    ).passed,
  ).toBe(false);
});
test("percentiles use the nearest-rank convention", () => {
  expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  expect(
    quantile(
      Array.from({ length: 25 }, (_, i) => i + 1),
      0.9,
    ),
  ).toBe(23);
});

const rateQuestion = {
  id: "Q03",
  question: "Rate question",
  expected: "answered",
  answer_shape: "Descending rate and independent counts and population",
};
const rateRun: RecordedAnswer = {
  id: "r",
  question: "Rate question",
  status: "answered",
  rounds: 1,
  answer: {
    answer: {
      headline: "Census Tract 1 has a rate of 10.",
      points: ["Five violations for 500 residents."],
      how_sure: "These are source counts.",
      caveats: [],
    },
    headers: ["name", "violations_per_1000_residents", "violations_count", "total_population", "geoid"],
    rows: [["Census Tract 1", "10", "5", "500", "01101000100"]],
    sql: "SELECT totalpopulation FROM source ORDER BY violations_per_1000_residents DESC",
    view: "answers.example",
    plan: {
      years: { from: 2025, to: 2025 },
      analysis: { basis: "rates", denominator: "residents", relationship: false },
    },
    sources: [
      {
        title: "Code Violations",
        url: "https://example.invalid",
        filter: "Year='2025'",
        records: 5,
        sourceCount: 5,
      },
    ],
  },
};
const sourceReference = {
  tracts: [["01101000100", "Census Tract 1"]] as [string, string][],
  counts: [{ title: "Code Violations", rows: [["01101000100", "5"]] as [string, string][] }],
  health: [{ headers: ["tractfips", "totalpopulation"], rows: [["01101000100", "500"]] }],
};
test("rate grading checks the arithmetic and both independent source inputs", () => {
  expect(gradeQuestion(rateQuestion, rateRun, sourceReference).passed).toBe(true);
  for (const [column, value, reason] of [
    [1, "20", "Rate arithmetic"],
    [2, "6", "Counts match independent"],
    [3, "600", "denominators match source"],
  ] as const) {
    const changed = structuredClone(rateRun);
    changed.answer.rows![0]![column] = value;
    expect(
      gradeQuestion(rateQuestion, changed, sourceReference).reasons.some((r) => r.includes(reason)),
    ).toBe(true);
  }
});
test("an empty reference object cannot stand in for independent evidence", () => {
  const g = gradeQuestion(rateQuestion, rateRun, { tracts: [], counts: [], health: [] });
  expect(g.passed).toBe(false);
  expect(g.reasons.some((r) => r.includes("counts captured"))).toBe(true);
});

test("monthly results are checked by calendar order regardless of labels", () => {
  for (const label of ["7", "07", "2025-07", "202507", "July", "Jul"]) {
    expect(monthNumber(label)).toBe(7);
  }
  expect(Number.isNaN(monthNumber("unknown"))).toBe(true);
});
test("a generic rate alias still receives arithmetic validation", () => {
  const changed = structuredClone(rateRun);
  changed.answer.headers![1] = "violation_rate";
  changed.answer.rows![0]![1] = "20";
  expect(
    gradeQuestion(rateQuestion, changed, sourceReference).reasons.some((r) =>
      r.includes("Rate arithmetic violation_rate"),
    ),
  ).toBe(true);
});

test("paired eligibility uses the requested health measure when population has a separate source", () => {
  const run = structuredClone(rateRun);
  run.question = "Unit association question";
  run.answer.plan!.analysis!.relationship = true;
  run.answer.headers = [
    "name",
    "violations_per_1000_residents",
    "violations_count",
    "total_population",
    "bphigh_crudeprev",
    "correlation",
    "paired_tracts",
    "geoid",
  ];
  run.answer.rows = [
    ["Census Tract 1", "10", "5", "500", "30", "1", "2", "01101000100"],
    ["Census Tract 2", "20", "10", "500", "40", "1", "2", "01101000200"],
  ];
  run.answer.answer = {
    headline: "The correlation is 1 across 2 paired tracts.",
    points: ["These are CDC estimated prevalence values."],
    how_sure: "This is a descriptive association.",
    caveats: [],
  };
  run.answer.sources!.push({
    title: "CDC PLACES",
    url: "https://data.cdc.gov/resource/unit",
    filter: "countyfips='01101'",
    records: 2,
    sourceCount: 2,
  });
  const reference = {
    tracts: [
      ["01101000100", "Census Tract 1"],
      ["01101000200", "Census Tract 2"],
    ] as [string, string][],
    counts: [
      {
        title: "Code Violations",
        rows: [
          ["01101000100", "5"],
          ["01101000200", "10"],
        ] as [string, string][],
      },
    ],
    health: [
      {
        headers: ["tractfips", "totalpopulation"],
        rows: [
          ["01101000100", "500"],
          ["01101000200", "500"],
        ],
      },
      {
        headers: ["tractfips", "totalpopulation", "bphigh_crudeprev"],
        rows: [
          ["01101000100", "500", "30"],
          ["01101000200", "500", "40"],
        ],
      },
    ],
  };
  expect(
    gradeQuestion(
      { id: "Q05", question: run.question, expected: "answered", answer_shape: "Paired rates" },
      run,
      reference,
    ).passed,
  ).toBe(true);
});
const q11 = {
  id: "Q11",
  question: "Which Montgomery census tracts had the most 911 calls in 2025?",
  expected: "stopped-honestly",
  answer_shape: "Stop honestly",
};
const q11Stop: RecordedAnswer = {
  id: "r_20261024_a9150b",
  question: q11.question,
  status: "failed",
  rounds: 0,
  answer: {
    message:
      "I could not find a dataset for Montgomery with 911 Calls publishes a table without tract locations. A citywide summary may be possible; tract counts cannot be inferred.",
  },
};
test("Q11 passes when Fieldwork stops because the 911 source has no tract locations", () => {
  expect(gradeQuestion(q11, q11Stop).passed).toBe(true);
});
test("Q11 does not pass on a budget failure or an invented tract answer", () => {
  expect(
    gradeQuestion(q11, { ...q11Stop, answer: { message: "Daily model budget reached; try again tomorrow." } })
      .passed,
  ).toBe(false);
  expect(
    gradeQuestion(q11, {
      ...q11Stop,
      status: "answered",
      answer: { ...q11Stop.answer, headers: ["geoid", "calls"], rows: [["01101000100", "5"]] },
    }).passed,
  ).toBe(false);
});
test("frozen questions allow only recorded amendments", () => {
  const o = [{ id: "Q11", question: "Q?", expected: "answered", answer_shape: "A" }];
  const am = [
    {
      id: "Q11",
      from: { expected: "answered", answer_shape: "A" },
      to: { expected: "stopped-honestly", answer_shape: "B" },
    },
  ];
  expect(checkFrozen(o, [{ ...o[0]!, expected: "stopped-honestly", answer_shape: "B" }], am)).toBeUndefined();
  expect(checkFrozen(o, [{ ...o[0]!, expected: "stopped-honestly", answer_shape: "B" }], [])).toBeDefined();
  expect(
    checkFrozen(o, [{ ...o[0]!, question: "Other?", expected: "stopped-honestly", answer_shape: "B" }], am),
  ).toBeDefined();
  expect(checkFrozen(o, o, am)).toBeDefined();
});

import { readFileSync } from "node:fs";
test("monthly comparison uses the question year despite previous-year reference months", () => {
  const run = JSON.parse(readFileSync("evidence/runs/r_20261025_617a2f.run.json", "utf8"));
  const reference = JSON.parse(readFileSync("evidence/runs/r_20261025_617a2f.reference.json", "utf8"));
  const q = JSON.parse(readFileSync("evidence/questions.json", "utf8")).questions.find(
    (q: { id: string }) => q.id === "Q07",
  );
  const check = (r: RecordedAnswer) =>
    gradeQuestion(q, r, reference).checks.find(
      (c) => c.name === "Monthly totals match independent source aggregation",
    )!.ok;
  expect(reference.observations[0].months.some((r: string[]) => r[0] === "2025")).toBe(true);
  expect(check(run)).toBe(true);
  reference.observations[0].months.reverse();
  expect(check(run)).toBe(true);
  const bad = structuredClone(run);
  bad.answer.rows[0][2] = String(Number(bad.answer.rows[0][2]) + 1);
  expect(check(bad)).toBe(false);
});

test("grader correction rate_columns: a correlation column is not a rate and fac_count is the EPA count (Q20, 25 Oct)", () => {
  const a = JSON.parse(readFileSync("evidence/runs/r_20261025_f5b9ce.run.json", "utf8")).answer;
  const q = {
    id: "Q20",
    question:
      "Do Montgomery tracts with more EPA-listed facilities per 1,000 residents also have higher adult asthma prevalence?",
    expected: "answered",
    answer_shape: "x",
  };
  const run = { id: "r", question: q.question, status: "answered", rounds: 1, answer: a } as RecordedAnswer;
  const names = (g: ReturnType<typeof gradeQuestion>) =>
    g.checks.filter((c) => /^Rate arithmetic/.test(c.name));
  const ref = { tracts: [], counts: [], health: [] };
  expect(names(gradeQuestion(q, run, ref)).map((c) => [c.name, c.ok])).toEqual([
    ["Rate arithmetic epa_facilities_per_1000_totalpopulation", true],
  ]);
  const wrong = {
    ...run,
    answer: {
      ...a,
      rows: a.rows.map((r: (string | null)[], k: number) => (k === 0 ? [r[0], "1.0", ...r.slice(2)] : r)),
    },
  };
  expect(names(gradeQuestion(q, wrong, ref)).every((c) => c.ok)).toBe(false);
});
