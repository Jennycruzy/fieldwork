import { checkSql, type QueryResult } from "@fieldwork/zetaris";

export interface LineageSource {
  datasource: string;
  alias: string;
}
export interface AnswerLineage {
  status: "verified" | "unavailable";
  checked_at: string;
  view: string;
  view_sources: LineageSource[];
  query_sources: LineageSource[];
  message?: string;
}
type QueryClient = { query(sql: string, limit?: number): Promise<QueryResult> };

export function lineageSql(selectSql: string): string {
  const checked = checkSql(selectSql, "reader");
  if (!checked.ok) throw new Error("Lineage needs one validated SELECT: " + checked.reason);
  return "INFER SQLTABLE SOURCES SPEC " + selectSql.trim().replace(/;\s*$/, "");
}

function sources(result: QueryResult): LineageSource[] {
  const source = result.headers.findIndex((h) => /^datasource$/i.test(h));
  const alias = result.headers.findIndex((h) => /^alias$/i.test(h));
  if (source < 0) throw new Error("Zetaris did not return the source-table column");
  return result.rows
    .filter((row) => row[source])
    .map((row) => ({ datasource: row[source]!, alias: alias < 0 ? "" : (row[alias] ?? "") }));
}

// Source names come from Zetaris, never from a guessed interpretation of the SQL.
export async function answerLineage(z: QueryClient, view: string, selectSql: string): Promise<AnswerLineage> {
  if (!/^fieldwork_answers\.answer_[a-f0-9]{6}$/.test(view)) throw new Error("Invalid saved answer view");
  const result: AnswerLineage = {
    status: "unavailable",
    checked_at: new Date().toISOString(),
    view,
    view_sources: [],
    query_sources: [],
  };
  try {
    const query = lineageSql(selectSql);
    result.view_sources = sources(await z.query(lineageSql("SELECT * FROM " + view), 100));
    result.query_sources = sources(await z.query(query, 100));
    if (!result.view_sources.length || !result.query_sources.length)
      throw new Error("Zetaris returned no source tables");
    result.status = "verified";
  } catch (error) {
    result.message = error instanceof Error ? error.message : "Lineage request failed";
  }
  return result;
}
