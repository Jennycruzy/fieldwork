import { write } from "../src/agents/writer.js";
import { expect, test, vi } from "vitest";
import { writerChunks } from "../src/writerChunks.js";
import type { Ctx } from "../src/agents/context.js";
import type { Plan } from "@fieldwork/core";
const plan: Plan = {
  in_scope: true,
  geography: "tract",
  output: "ranking",
  measures: [],
  analysis: {
    basis: "counts",
    denominator: "none",
    relationship: false,
    rank_measure: "events descending",
    reason: "Workload",
  },
};
const rows = Array.from({ length: 71 }, (_, i) => ["Census Tract " + (i + 1), String(71 - i), "geo" + i]);
const joined = {
  sql: "SELECT tract_name,event_count,geoid FROM counts",
  result: { headers: ["tract_name", "event_count", "geoid"], rows, total: 71, ms: 0, wallMs: 0 },
};
test("the Writer processes real row chunks with checked carryover and no repeated first-chunk rows", async () => {
  const json = vi
    .fn()
    .mockResolvedValueOnce({
      value: { facts: [{ row_index: 0, text: "Census Tract 1 has 71 events." }] },
      calls: [],
    })
    .mockResolvedValueOnce({
      value: { facts: [{ row_index: 40, text: "Census Tract 41 has 31 events." }] },
      calls: [],
    });
  const ctx = {
    cfg: { markovianWriter: true },
    models: { writer: { json } },
    trace: { log: vi.fn() },
  } as unknown as Ctx;
  const result = await writerChunks(ctx, "Where are recorded events?", plan, joined, []);
  expect(result?.engine.status).toBe("completed");
  expect(result?.facts).toHaveLength(2);
  const second = JSON.stringify(json.mock.calls[1]);
  expect(second).toContain("Census Tract 1 has 71 events.");
  expect(second).not.toContain("Census Tract 20");
  expect(result?.engine.chunks[1]?.carryover).toContain("Census Tract 1 has 71 events.");
  expect(ctx.trace.log).toHaveBeenCalledWith(expect.objectContaining({ action: "markovian_chunk" }));
  expect(await writerChunks(ctx, "Where are recorded events?", plan, joined, [])).toBe(result);
  expect(json).toHaveBeenCalledTimes(2);
  json.mockResolvedValueOnce({
    value: {
      headline: "The checked table lists recorded events.",
      points: ["Census Tract 1 has 71 events."],
      how_sure: "The source rows were checked.",
      caveats: [],
    },
  });
  await write(ctx, "Where are recorded events?", plan, [], joined, [], 1);
  const finalPrompt = JSON.stringify(json.mock.calls[2]);
  expect(finalPrompt).toContain("checked_chunk_facts");
  expect(finalPrompt).toContain("Census Tract 41 has 31 events.");
  expect(finalPrompt).not.toContain("Census Tract 20");
  expect(json).toHaveBeenCalledTimes(3);
});
test("unchecked claims cannot enter the carried state, and the default path makes no chunk calls", async () => {
  const json = vi
    .fn()
    .mockResolvedValueOnce({
      value: { facts: [{ row_index: 0, text: "Census Tract 1 has 999 events." }] },
      calls: [],
    })
    .mockResolvedValueOnce({
      value: { facts: [{ row_index: 40, text: "Census Tract 41 has 31 events." }] },
      calls: [],
    });
  const ctx = {
    cfg: { markovianWriter: false },
    models: { writer: { json } },
    trace: { log: vi.fn() },
  } as unknown as Ctx;
  expect(await writerChunks(ctx, "Events?", plan, joined, [])).toBeUndefined();
  expect(json).not.toHaveBeenCalled();
  ctx.cfg.markovianWriter = true;
  const result = await writerChunks(ctx, "Events?", plan, joined, []);
  expect(result?.facts.some((f) => f.text.includes("999"))).toBe(false);
  expect(result?.engine.chunks[1]?.carryover).not.toContain("999");
});
