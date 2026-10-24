import { describe, expect, it } from "vitest";
import { isNewestInSeries, releaseYear } from "../src/agents/finder.js";
import type { Candidate } from "@fieldwork/sources";

const c = (title: string): Candidate => ({ catalog: "socrata", id: title, title, description: "", url: "", kind: "socrata_resource" });

describe("newest release in a series", () => {
  // Titles as they appear in CDC's catalog (seen live, 24 Oct).
  const all = [c("PLACES: Census Tract Data (GIS Friendly Format), 2025 release"), c("PLACES: Census Tract Data (GIS Friendly Format), 2022 release"), c("500 Cities: Census Tract-level Data (GIS Friendly Format), 2019 release")];

  it("reads the release year from the end of a title", () => {
    expect(releaseYear(all[0]!.title)).toBe(2025);
  });

  it("marks only the latest of each series", () => {
    expect(isNewestInSeries(all[0]!, all)).toBe(true);
    expect(isNewestInSeries(all[1]!, all)).toBe(false);
    expect(isNewestInSeries(all[2]!, all)).toBe(true); // a different series
  });
});
