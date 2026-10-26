import { describe, expect, it } from "vitest";
import { createAnswerView } from "@fieldwork/zetaris";

describe("saving an answer as a SchemaStore view", () => {
  it("wraps the checked SELECT in the syntax Zetaris accepted live", () => {
    expect(createAnswerView("b552f2", "SELECT t.name FROM fw_pg.tracts t;")).toBe(
      "CREATE SCHEMASTORE VIEW answer_b552f2 WITH CONTAINER fieldwork_answers AS SELECT t.name FROM fw_pg.tracts t",
    );
  });
  it("refuses anything but a single read query", () => {
    expect(() => createAnswerView("b552f2", "DROP TABLE fw_pg.tracts")).toThrow();
    expect(() => createAnswerView("b552f2", "SELECT 1; SELECT 2")).toThrow();
  });
});
