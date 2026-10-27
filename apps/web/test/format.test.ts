import { expect, test } from "vitest";
import { figure, label } from "../src/format";

test("query columns read as plain words", () => {
  expect(label("code_violations_count_per_1000_totalpopulation")).toBe("Code violations per 1,000 residents");
  expect(label("casthma_crudeprev")).toBe("Adult asthma (% of adults)");
  expect(label("geoid")).toBe("Tract ID");
  expect(label("tract_name")).toBe("Tract");
});

test("figures are rounded for reading and IDs are left alone", () => {
  expect(figure("562.1993127147766")).toBe("562.2");
  expect(figure("1125")).toBe("1,125");
  expect(figure("1455.0")).toBe("1,455");
  expect(figure("01101001200")).toBe("01101001200");
  expect(figure(null)).toBe("—");
});
