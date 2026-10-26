import { expect, test } from "vitest";
import { renderRecipe, type RecipeSource } from "../src/index.js";
const source: RecipeSource = {
  id: "public-id",
  slug: "public_events",
  number: 15,
  kind: "arcgis",
  title: "Public Events",
  endpoint: "https://example.org/FeatureServer/0/query",
  count: 2500,
  page_size: 2000,
  where: "Year = 2025",
  fields: ["OBJECTID", "Year"],
  licence: { status: "unresolved" },
  docs: "https://example.org",
  checked_at: "2026-10-26",
};
test("ArcGIS recipes page without overlap, cache each page and explode features", () => {
  const r = renderRecipe(source);
  expect(r.create.match(/CREATE LIGHTNING REST TABLE/g)).toHaveLength(2);
  expect(r.create.match(/CACHE TABLE/g)).toHaveLength(2);
  expect(r.create).toContain("resultOffset=0");
  expect(r.create).toContain("resultOffset=2000");
  expect(r.create).toContain("resultRecordCount=2000");
  expect(r.create.match(/explode\(features\)/g)).toHaveLength(2);
  expect(r.create).toContain("UNION ALL");
  expect(r.manifest.status).toBe("unverified");
  expect(r.catalogNote).toContain("unresolved");
  expect(r.create).toContain("CREATE LIGHTNING DATABASE PUBLIC_EVENTS_REST ");
  expect(r.create).toContain("CREATE SCHEMASTORE CONTAINER public_events;");
});
test("bare JSON array recipes read columns directly rather than exploding a fictitious wrapper", () => {
  const r = renderRecipe({
    ...source,
    kind: "socrata",
    count: 71,
    endpoint: "https://example.org/resource/abcd.json",
    fields: ["tractfips", "population"],
  });
  expect(r.create).toContain("SELECT tractfips, population FROM");
  expect(r.create).not.toContain("explode(");
  expect(r.select.split("\n").filter((l) => l.startsWith("SELECT"))).toEqual([]);
});
test("recipe paths, endpoints and SQL fields cannot carry injected writes or credentials", () => {
  expect(() => renderRecipe({ ...source, slug: "../escape" })).toThrow();
  expect(() => renderRecipe({ ...source, fields: ["Year; DROP TABLE x"] })).toThrow();
  expect(() => renderRecipe({ ...source, endpoint: "https://secret:password@example.org" })).toThrow();
  expect(() => renderRecipe({ ...source, count: 0 })).toThrow();
  expect(() => renderRecipe({ ...source, available_fields: ["OBJECTID"] })).toThrow("recorded source schema");
});
test("a recorded live run marks the recipe verified everywhere, and only when the counts agree", () => {
  const run = {
    ran_at: "2026-10-26T20:45:46Z",
    zetaris_version: "2.4.3.1",
    engine_version: "3.5.3",
    statements: 5,
    records: 2500,
  };
  const r = renderRecipe(source, run);
  expect(r.manifest.status).toBe("verified");
  expect(r.create).toContain("-- Status: Verified 2026-10-26 on Zetaris 2.4.3.1");
  expect(r.catalogRow).toContain("| Verified |");
  expect(r.catalogNote).toContain("**Verified** 2026-10-26");
  expect(r.howto).toContain("verified live on 2026-10-26");
  expect(() => renderRecipe(source, { ...run, records: 2499 })).toThrow("record count");
});
