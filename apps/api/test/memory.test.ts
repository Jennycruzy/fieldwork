import { expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { HMEM, remember } from "@fieldwork/hmem";
import { learnFromRun } from "../src/memory.js";
import { wire } from "../src/agents/wirer.js";
import type { Ctx } from "../src/agents/context.js";
const run = JSON.parse(readFileSync("evidence/runs/r_20261024_a9150b.run.json", "utf8"));
const candidate = {
  catalog: "montgomery_hub" as const,
  id: "911",
  title: "911 Calls",
  url: "https://example.invalid/FeatureServer/0",
  description: "Monthly call totals",
  kind: "arcgis_layer" as const,
};
const chosen = {
  measureId: "m1",
  measure: run.question,
  candidate,
  reason: "directly provides census-tract-level counts",
  fields: [],
};
function context() {
  const client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };
  return {
    runId: run.id,
    cfg: { place: { name: "Montgomery, AL" } },
    memory: new HMEM(),
    recalled: [],
    trace: { log: vi.fn() },
    db: { query: vi.fn(), connect: async () => client },
    models: {
      wirer: { json: async () => ({ value: { sources: [{ measure_id: "m1", where: "1=1", fields: [] }] } }) },
    },
  } as unknown as Ctx;
}
test("the recorded 911 wiring failure names the source and the missing locations in one sentence", async () => {
  const ctx = context();
  await expect(wire(ctx, run.answer.plan, [chosen])).rejects.toMatchObject({
    code: "NO_SOURCE",
    message: "911 Calls publishes no tract locations, so tract counts cannot be inferred.",
  });
});
test("failed wiring never saves the Finder's unsupported tract claim and corrects earlier copies", async () => {
  const ctx = context();
  const old = remember(ctx.memory, {
    kind: "choice",
    runId: run.id,
    content: '"911 Calls" directly provides census-tract-level counts',
    confidence: 0.8,
    datasetTitle: "911 Calls",
  });
  await learnFromRun(
    ctx,
    { question: run.question, status: "failed", chosen: [chosen], wired: [], repairs: [] },
    0,
  );
  const memories = ctx.memory.store.all();
  expect(memories.some((m) => m.content.includes("directly provides census-tract-level counts"))).toBe(false);
  expect(ctx.memory.store.get(old.id)?.tags).toContain("fw:quality");
  expect(memories.some((m) => m.content.includes("nonspatial table with no tract locations"))).toBe(true);
  expect(memories.some((m) => m.tags.includes("fw:choice"))).toBe(false);
});
