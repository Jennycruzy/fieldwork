// SQL for the source shapes we have seen work in Zetaris 2.4.3.1 (live checks, 24 Oct 2026).

import { opt } from "./sql.js";

export type Shape = "socrata_list" | "arcgis_features" | "arcgis_stats";

// Option list shared by TEST REST REQUEST and CREATE REST SESSION TABLE (syntax from the Lightning command reference, 6.1 and 6.6).
const OPTIONS = (endpoint: string) =>
  `(endpoint ${opt(endpoint)}, method "GET", http_encoding "URLENCODED", response_type "JSON", insecure_ssl "false") HEADER () BODY ()`;

export function testRequest(endpoint: string): string {
  return `TEST REST REQUEST ${OPTIONS(endpoint)}`;
}

export function createSessionTable(table: string, endpoint: string): string {
  return `CREATE REST SESSION TABLE ${table} REQUEST ${OPTIONS(endpoint)}`;
}

// How to read rows out of a registered table, per shape.
// socrata_list: the response is a bare JSON list; columns are queryable directly.
// arcgis_*: the response is an object with a "features" list; explode it.
export function rowsFrom(table: string, shape: Shape): { from: string; field: (name: string) => string } {
  if (shape === "socrata_list") {
    return { from: `session.${table}`, field: (n) => quoteIdent(n) };
  }
  return {
    from: `session.${table} LATERAL VIEW explode(features) AS f`,
    field: (n) => `f.attributes.${quoteIdent(n)}`,
  };
}

export function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unsafe field name: ${name}`);
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `\`${name}\``;
}
