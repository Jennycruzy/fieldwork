import { expect, test } from "vitest";
import { AnswerSchema } from "../src/types.js";

test("an answer without a caveats list is valid and has no caveats", () => {
  const r = AnswerSchema.safeParse({
    headline: "Tract 24 is first.",
    points: ["Tract 24: 31.5%."],
    how_sure: "CDC estimates.",
  });
  expect(r.success).toBe(true);
  expect(r.success && r.data.caveats).toEqual([]);
});
