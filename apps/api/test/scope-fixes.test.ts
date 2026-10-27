import { expect, test } from "vitest";
import { applyScopeFixes } from "../src/agents/writer.js";

const located = {
  id: "bridge_match",
  ok: true,
  detail: "15,103 of 15,103 located records fell inside a tract (100.0%); 0 outside, 336 without a location",
  locationAccounting: { total: 15439, invalid: 336, matched: 15103, unmatched: 0 },
};
const answer = () => ({
  headline: "Census Tract 12 has the highest adult asthma rate at 14.0%.",
  points: [
    "Census Tract 12 leads with 14.0% adult asthma prevalence and 818 code violations, the highest code violations among the top 10 tracts",
    "The top three tracts account for 1,785 of the 15,103 total code violations citywide in 2025",
  ],
  how_sure: "CDC values are model-based estimates.",
  caveats: [],
});

test("an unchecked rank inside a subset is removed, the primary fact stays", () => {
  const v = applyScopeFixes(answer(), []);
  expect(v.points[0]).toBe(
    "Census Tract 12 leads with 14.0% adult asthma prevalence and 818 code violations",
  );
  expect(v.headline).toBe("Census Tract 12 has the highest adult asthma rate at 14.0%.");
});

test("a total that leaves out unlocated records is not called citywide", () => {
  const v = applyScopeFixes(answer(), [located as never]);
  expect(v.points[1]).toBe(
    "The top three tracts account for 1,785 of the 15,103 total code violations placed in a tract in 2025",
  );
  expect(v.caveats.join(" ")).toContain("336 of 15,439 source records had no usable location");
});

test("with every record located, citywide wording is left alone", () => {
  const all = { ...located, locationAccounting: { total: 15103, invalid: 0, matched: 15103, unmatched: 0 } };
  const v = applyScopeFixes(answer(), [all as never]);
  expect(v.points[1]).toContain("citywide");
  expect(v.caveats).toEqual([]);
});
