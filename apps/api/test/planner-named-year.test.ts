import { expect, test } from "vitest";
import { fillNamedYear } from "../src/agents/planner.js";

const q01 =
  "Which Montgomery census tracts have the highest adult asthma rates, and how many code violations did each have in 2025?";

test("an empty plan year is filled from the one year the question names (Q01, batch 15)", () => {
  expect(fillNamedYear(q01, { in_scope: true, years: { from: null, to: null } }).years).toEqual({
    from: 2025,
    to: 2025,
  });
  expect(fillNamedYear(q01, { in_scope: true, years: null }).years).toEqual({ from: 2025, to: 2025 });
});

test("planned years, two named years, no named year and refusals are left alone", () => {
  expect(fillNamedYear(q01, { in_scope: true, years: { from: 2024, to: 2025 } }).years).toEqual({
    from: 2024,
    to: 2025,
  });
  expect(
    fillNamedYear("Which tracts changed most from 2024 to 2025?", {
      in_scope: true,
      years: { from: null, to: null },
    }).years,
  ).toEqual({ from: null, to: null });
  expect(
    fillNamedYear("Which tracts in 2024 and in 2025 had the most permits?", { in_scope: true, years: null })
      .years,
  ).toBeNull();
  expect(
    fillNamedYear("Which tracts have the most pharmacies?", { in_scope: true, years: null }).years,
  ).toBeNull();
  expect(fillNamedYear(q01, { in_scope: false, years: null }).years).toBeNull();
});
