import { expect, test } from "vitest";
import { observation, observationRoles } from "../src/observations.js";
test("normalization retains event units while hashing entity names", () => {
  const r = observation("id", null, {
    date: "2025-12-17",
    entity: "Unit-only establishment",
    entityLocation: "Unit-only location",
    value: "85",
    valueKind: "score",
  });
  expect(r.year).toBe(2025);
  expect(r.month).toBe(12);
  expect(r.value).toBe(85);
  expect(r.entity_key).not.toContain("establishment");
  expect(JSON.stringify(r)).not.toContain("location");
});
test("aggregate months and counts preserve their meaning", () => {
  const r = observation("id", null, {
    year: "2025",
    month: "01 - January",
    value: "22575",
    valueKind: "count",
  });
  expect(r.month).toBe(1);
  expect(r.value).toBe(22575);
});

test("source roles distinguish food scores from geocoder confidence", () => {
  const fields = ["Date", "Score", "Score_1", "Match_type", "Establishment", "Address"].map((name) => ({
    name,
  }));
  expect(observationRoles(fields, true)).toMatchObject({
    valueField: "Score_1",
    valueKind: "score",
    dateField: "Date",
    entityField: "Establishment",
  });
});
test("call summaries retain their published numeric unit", () => {
  const fields = [
    "Year",
    "Month",
    "Call_Category",
    "Call_Count_By_Origin",
    "Call_Count_by_Phone_Service_Pro",
  ].map((name) => ({ name }));
  expect(observationRoles(fields, false)).toMatchObject({
    yearField: "Year",
    monthField: "Month",
    categoryField: "Call_Category",
    valueField: "Call_Count_By_Origin",
    valueKind: "count",
  });
});
test("the same establishment identity is stable across inspections", () => {
  const a = observation("first", null, {
    entity: "Example",
    entityLocation: "Same",
    date: "2025-01-01",
    value: "80",
    valueKind: "score",
  });
  const b = observation("second", null, {
    entity: " EXAMPLE ",
    entityLocation: " SAME ",
    date: "2025-02-01",
    value: "90",
    valueKind: "score",
  });
  expect(a.entity_key).toBe(b.entity_key);
  expect(a.record_id).not.toBe(b.record_id);
  expect(observation("third", null, { entity: "Example", entityLocation: "Other" }).entity_key).not.toBe(
    a.entity_key,
  );
});
test("invalid dates and values stay missing rather than becoming zero", () => {
  expect(observation("id", null, { date: "invalid", value: "invalid", valueKind: "score" })).toMatchObject({
    event_date: null,
    year: null,
    month: null,
    value: null,
  });
  expect(observation("id", null, { date: "1750118400000", value: "0", valueKind: "score" })).toMatchObject({
    event_date: "2025-06-17T00:00:00.000Z",
    value: 0,
  });
});

test("missing aggregate values are not substituted with event counts", () => {
  expect(observation("id", null, { valueKind: "count" }).value).toBe(1);
  expect(observation("id", null, { value: null, valueKind: "count" }).value).toBeNull();
  expect(observation("id", null, { value: "", valueKind: "score" }).value).toBeNull();
  expect(observation("id", null, { value: "0", valueKind: "count" }).value).toBe(0);
});
