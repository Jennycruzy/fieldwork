import { expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { getJson, layerCount } from "@fieldwork/sources";
import { emptyFilterHints } from "../src/agents/wirer.js";
import { fullRunId } from "../src/agents/joiner.js";
import type { Chosen } from "../src/agents/finder.js";
vi.mock("@fieldwork/sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fieldwork/sources")>()),
  getJson: vi.fn(),
  layerCount: vi.fn(),
}));

test("Q10 (25 Oct): the short form of this run's id is corrected, other ids are left alone", () => {
  const sql = JSON.parse(readFileSync("evidence/runs/r_20261025_28edaa.run.json", "utf8")).answer
    .sql as string;
  expect(sql).toContain("run_id = 'r_28edaa'");
  const fixed = fullRunId(sql, "r_20261025_28edaa");
  expect(fixed).toContain("run_id = 'r_20261025_28edaa'");
  expect(fixed).not.toContain("'r_28edaa'");
  expect(fullRunId("SELECT 1 WHERE run_id = 'r_20261024_aaaaaa'", "r_20261025_28edaa")).toBe(
    "SELECT 1 WHERE run_id = 'r_20261024_aaaaaa'",
  );
});

test("Q17 (25 Oct): a filter that matched none of the shelter layer's 6 records is reported with the real TYPE values", async () => {
  const url =
    "https://services7.arcgis.com/xNUwUjOJqYE54USz/arcgis/rest/services/Tornado_Shelter/FeatureServer/0";
  vi.mocked(layerCount).mockResolvedValue(6);
  vi.mocked(getJson).mockResolvedValue({
    features: [
      { attributes: { n: 2, TYPE: "GENEARL" } },
      { attributes: { n: 2, TYPE: "GENERAL" } },
      { attributes: { n: 1, TYPE: "MEDICAL NEEDS" } },
      { attributes: { n: 1, TYPE: "NO COTS" } },
    ],
  });
  const chosen = [
    {
      measureId: "m1",
      measure: "Listed emergency shelters",
      candidate: { kind: "arcgis_layer", url, title: "Tornado Shelter" },
      fields: [
        { name: "TYPE", type: "string" },
        { name: "SHELTER", type: "string" },
      ],
    },
  ] as unknown as Chosen[];
  const where = "TYPE IN ('Emergency Shelter', 'Shelter', 'Homeless Shelter')";
  const hints = await emptyFilterHints(chosen, [
    { measureId: "m1", title: "Tornado Shelter", where, sourceCount: 0 },
  ] as never);
  expect(hints.get("m1")).toContain("matched 0 of its 6 records");
  expect(hints.get("m1")).toContain("'GENERAL' (2)");
  expect(hints.get("m1")).toContain("'MEDICAL NEEDS' (1)");
  expect(
    (
      await emptyFilterHints(chosen, [
        { measureId: "m1", title: "Tornado Shelter", where, sourceCount: 4 },
      ] as never)
    ).size,
  ).toBe(0);
  expect(
    (
      await emptyFilterHints(chosen, [
        { measureId: "m1", title: "Tornado Shelter", where: "1=1", sourceCount: 0 },
      ] as never)
    ).size,
  ).toBe(0);
});
