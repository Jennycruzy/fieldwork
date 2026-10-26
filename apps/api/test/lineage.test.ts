import { expect, test, vi } from "vitest";
import { answerLineage, lineageSql } from "../src/lineage.js";
const view = "fieldwork_answers.answer_abcdef";
test("lineage distinguishes the saved view from its query's actual Zetaris tables", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ headers: ["datasource", "alias"], rows: [[view, "answer_abcdef"]] })
    .mockResolvedValueOnce({
      headers: ["datasource", "alias"],
      rows: [
        ["FW_PG.tracts", "t"],
        ["session.fw_abcdef_cdc", "h"],
      ],
    });
  const result = await answerLineage({ query }, view, "SELECT t.geoid FROM fw_pg.tracts t");
  expect(query).toHaveBeenNthCalledWith(1, "INFER SQLTABLE SOURCES SPEC SELECT * FROM " + view, 100);
  expect(result.status).toBe("verified");
  expect(result.query_sources.map((s) => s.datasource)).toEqual(["FW_PG.tracts", "session.fw_abcdef_cdc"]);
  expect(result.view_sources[0]?.datasource).toBe(view);
});
test("unavailable lineage is explicit and no sources are invented", async () => {
  const query = vi.fn().mockRejectedValue(new Error("Lineage unavailable"));
  const result = await answerLineage({ query }, view, "SELECT geoid FROM fw_pg.tracts");
  expect(result.status).toBe("unavailable");
  expect(result.query_sources).toEqual([]);
  expect(result.message).toBe("Lineage unavailable");
});
test("lineage refuses injected views and statements before issuing any query", async () => {
  const query = vi.fn();
  await expect(
    answerLineage({ query }, "fieldwork_answers.answer_abcdef; DROP TABLE x", "SELECT 1"),
  ).rejects.toThrow("Invalid saved answer view");
  expect(lineageSql("WITH x AS (SELECT 1) SELECT * FROM x;")).toBe(
    "INFER SQLTABLE SOURCES SPEC WITH x AS (SELECT 1) SELECT * FROM x",
  );
  expect(() => lineageSql("SELECT 1; DROP TABLE x")).toThrow("validated SELECT");
  expect(query).not.toHaveBeenCalled();
});
