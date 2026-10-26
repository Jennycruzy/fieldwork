import { test, expect, vi } from "vitest";
import { runBudget, RunCallLimit } from "../src/runBudget.js";
test("the first pass has eight calls and each Evaluator revision permits three more", async () => {
  const take = vi.fn(async () => true),
    r = runBudget({ take });
  for (let i = 0; i < 8; i++) expect(await r.budget.take()).toBe(true);
  await expect(r.budget.take()).rejects.toBeInstanceOf(RunCallLimit);
  expect(take).toHaveBeenCalledTimes(8);
  r.evaluationRound(2);
  for (let i = 0; i < 3; i++) await r.budget.take();
  expect(r.calls).toBe(11);
  await expect(r.budget.take()).rejects.toBeInstanceOf(RunCallLimit);
  r.evaluationRound(3);
  for (let i = 0; i < 3; i++) await r.budget.take();
  expect(r.calls).toBe(14);
  r.evaluationRound(4);
  expect(r.limit).toBe(14);
});
test("parallel calls reserve the final slot and a denied daily call is not charged", async () => {
  const r = runBudget({ take: async () => true });
  for (let i = 0; i < 7; i++) await r.budget.take();
  const results = await Promise.allSettled([r.budget.take(), r.budget.take()]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(r.calls).toBe(8);
  const denied = runBudget({ take: async () => false });
  expect(await denied.budget.take()).toBe(false);
  expect(denied.calls).toBe(0);
});

test("a request the provider failed without a reply returns to the run allowance", async () => {
  const take = vi.fn(async () => true),
    r = runBudget({ take });
  for (let i = 0; i < 8; i++) await r.budget.take();
  r.budget.release?.();
  r.budget.release?.();
  expect(r.calls).toBe(6);
  await r.budget.take();
  expect(take).toHaveBeenCalledTimes(9);
});
