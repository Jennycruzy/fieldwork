import { expect, test, vi } from "vitest";
import { evaluate } from "../src/agents/evaluator.js";
import { Trace } from "../src/trace.js";
import type { Ctx } from "../src/agents/context.js";
import type { Db } from "../src/db.js";
test("real quality checks reach weak-match and small-group notices", async () => {
  const log = vi.fn();
  const ctx = {
    cfg: { place: { countyName: "Montgomery", stateAbbr: "AL", stateFips: "01", countyFips: "101" } },
    today: new Date("2026-10-24"),
    trace: { log },
    models: { evaluator: { json: async () => ({ value: { verdict: "APPROVE", reasons: [] } }) } },
  } as unknown as Ctx;
  await evaluate(
    ctx,
    "rates",
    {
      in_scope: true,
      geography: "tract",
      measures: [],
      output: "list",
      analysis: {
        basis: "rates",
        denominator: "residents",
        relationship: false,
        reason: "Compare burdens",
        rank_measure: "none",
      },
    },
    [],
    [{ label: "x", matched: 10, total: 100, invalid: 0, unmatched: 90, duplicates: 0, tractsWithRecords: 2 }],
    {
      sql: "SELECT name, rate, population FROM data",
      result: {
        headers: ["name", "rate", "population"],
        rows: [
          ["A", "1", "5"],
          ["B", "2", "8"],
        ],
        total: 2,
        ms: 0,
        wallMs: 0,
      },
    },
    1,
  );
  expect(log.mock.calls.some(([e]) => e.action === "JOIN_WEAK")).toBe(true);
  expect(log.mock.calls.some(([e]) => e.action === "SMALL_SAMPLE")).toBe(true);
});
test("provider recovery reaches MODEL_DOWN only after a call answers", async () => {
  const trace = new Trace({ query: async () => ({ rows: [] }) } as unknown as Db, "r_20261024_abcdef");
  const log = vi.fn();
  trace.onEvent(log);
  const call = trace.modelCall("writer");
  const record = {
    provider: "unit",
    modelRequested: "unit",
    modelServed: "unit",
    text: "{}",
    tokensIn: 0,
    tokensOut: 0,
    ms: 1,
    attempt: 1,
  };
  await call({ ...record, ok: false, error: "offline" });
  expect(log.mock.calls.some(([e]) => e.action === "MODEL_DOWN")).toBe(false);
  await call({ ...record, modelRequested: "backup", modelServed: "backup", ok: true });
  expect(log.mock.calls.some(([e]) => e.action === "MODEL_DOWN")).toBe(true);
});
