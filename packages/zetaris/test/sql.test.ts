import { describe, expect, it } from "vitest";
import { checkSql, createSessionTable, parseErrorMessage, quoteIdent, rowsFrom, tableName, testRequest } from "@fieldwork/zetaris";

describe("checkSql", () => {
  it("lets readers run SELECT and WITH", () => {
    expect(checkSql("SELECT 1", "reader").ok).toBe(true);
    expect(checkSql("WITH a AS (SELECT 1) SELECT * FROM a;", "reader").ok).toBe(true);
  });

  it("refuses writes and multiple statements", () => {
    expect(checkSql("DROP TABLE x", "reader").ok).toBe(false);
    expect(checkSql("SELECT 1; SELECT 2", "reader").ok).toBe(false);
    expect(checkSql("SELECT * FROM t WHERE 1=1; DELETE FROM t", "wirer").ok).toBe(false);
  });

  it("does not trip on keywords inside quoted URLs", () => {
    const sql = createSessionTable("fw_ab12_cdc", "https://example.org/data.json?update=1&delete=0");
    expect(checkSql(sql, "wirer")).toEqual({ ok: true });
  });

  it("only lets the Wirer create our own session tables", () => {
    expect(checkSql(createSessionTable("fw_x_y", "https://a.b/c"), "reader").ok).toBe(false);
    expect(checkSql('CREATE REST SESSION TABLE other REQUEST (endpoint "x") HEADER () BODY ()', "wirer").ok).toBe(false);
  });
});

describe("statement syntax (Lightning command reference 6.1, 6.6)", () => {
  it("writes TEST REST REQUEST with the keyword once", () => {
    expect(testRequest("https://a.b/c")).toMatch(/^TEST REST REQUEST \(endpoint "https:\/\/a\.b\/c", method "GET"/);
    expect(testRequest("https://a.b/c")).not.toMatch(/REQUEST REQUEST/);
  });
  it("writes CREATE REST SESSION TABLE <name> REQUEST (...) HEADER () BODY ()", () => {
    expect(createSessionTable("fw_x", "https://a.b/c")).toMatch(/^CREATE REST SESSION TABLE fw_x REQUEST \(endpoint .*\) HEADER \(\) BODY \(\)$/);
  });
});

describe("names and shapes", () => {
  it("builds safe table names", () => {
    expect(tableName("Ab-12", "Code Violations 2025!")).toBe("fw_ab_12_code_violations_2025");
  });

  it("reads Socrata lists directly and ArcGIS features by exploding", () => {
    expect(rowsFrom("fw_t", "socrata_list").field("casthma_crudeprev")).toBe("casthma_crudeprev");
    expect(rowsFrom("fw_t", "arcgis_features").from).toContain("explode(features)");
    expect(rowsFrom("fw_t", "arcgis_features").field("CaseType")).toBe("f.attributes.`CaseType`");
  });

  it("rejects unsafe field names", () => {
    expect(() => quoteIdent("a; drop")).toThrow();
  });
});

describe("parseErrorMessage", () => {
  it("keeps the source's own message (captured from a live Socrata 400, 24 Oct)", () => {
    const text = JSON.stringify({
      msg:
        "REST API call failed: Server returned HTTP response code: 400 for URL: https://data.cdc.gov/resource/swc5-untb.json?stateabbr=AL&countyname=Montgomery\n" +
        '  Response body: {\n  "error" : true,\n  "message" : "Unrecognized arguments [countyname]"\n}\n\n  Equivalent curl (sensitive values masked): curl ...',
    });
    const m = parseErrorMessage(text);
    expect(m.summary).toContain("HTTP response code: 400");
    expect(m.source).toBe("Unrecognized arguments [countyname]");
  });
});
