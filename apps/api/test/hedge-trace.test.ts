import { test, expect } from "vitest";
import { Trace } from "../src/trace.js";
import type { Db } from "../src/db.js";
import type { RunEvent } from "@fieldwork/core";
test("both hedged requests are traced while a cancelled loser is not a provider outage", async () => {
  const trace = new Trace({ query: async () => ({ rows: [] }) } as unknown as Db, "r_20261025_b87122");
  const events: RunEvent[] = [];
  trace.onEvent((e) => events.push(e));
  const call = trace.modelCall("joiner");
  const common = { text: "", tokensIn: 0, tokensOut: 0, provider: "openrouter", modelServed: "", ms: 1000 };
  await call({
    ...common,
    modelRequested: "slow:free",
    attempt: 1,
    ok: false,
    cancelled: true,
    error: "Stopped after another route returned a valid reply",
  });
  await call({ ...common, modelRequested: "fast:free", modelServed: "fast:free", attempt: 2, ok: true });
  expect(events.filter((e) => e.action === "model_call")).toHaveLength(2);
  expect(events.find((e) => e.modelRequested === "slow:free")?.status).toBe("info");
  expect(events.some((e) => e.action === "MODEL_DOWN")).toBe(false);
});
