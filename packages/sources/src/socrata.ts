// Socrata endpoints with SoQL in the URL. Zetaris reads these bare JSON lists directly.

import { getJson } from "./catalogs.js";

export function soqlUrl(resourceUrl: string, params: { where?: string; select?: string; limit?: number }): string {
  const p = new URLSearchParams();
  if (params.select) p.set("$select", params.select);
  if (params.where) p.set("$where", params.where);
  p.set("$limit", String(params.limit ?? 50000));
  // URLSearchParams encodes '$' as %24, the form Zetaris accepted in the live checks.
  return `${resourceUrl}?${p.toString()}`;
}

export async function socrataCount(resourceUrl: string, where?: string): Promise<number> {
  const rows = (await getJson(soqlUrl(resourceUrl, { select: "count(*) AS n", where, limit: 1 }))) as { n?: string }[];
  const n = Number(rows[0]?.n);
  if (!Number.isFinite(n)) throw new Error("Socrata did not return a count");
  return n;
}

export async function socrataColumns(resourceUrl: string): Promise<string[]> {
  const rows = (await getJson(soqlUrl(resourceUrl, { limit: 1 }))) as Record<string, unknown>[];
  return Object.keys(rows[0] ?? {});
}
