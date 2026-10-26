import type { QueryResult } from "@fieldwork/zetaris";

// Zetaris data-quality results for the Montgomery tract model that scripts/governed-model.ts builds.
export const TRACT_MODEL = "lightning.metastore.fieldwork.montgomery_neighborhoods";

export interface DataQualityResult {
  rule: string;
  table: "tract" | "tract_count";
  type: string;
  total: number;
  valid: number;
  invalid: number;
}
export interface AnswerDataQuality {
  status: "passed" | "failed" | "unavailable";
  checked_at: string;
  model: string;
  results: DataQualityResult[];
  message?: string;
}
type QueryClient = { query(sql: string, limit?: number): Promise<QueryResult> };

// The tract rules guard every tract answer; the count rules, including the foreign key that ties each count
// to a real tract, apply when the answer used city records placed into tracts.
const RULES: { rule: string; table: DataQualityResult["table"] }[] = [
  { rule: "geoid", table: "tract" },
  { rule: "montgomery_tract_geoid", table: "tract" },
  { rule: "positive_land_area", table: "tract" },
  { rule: "geoid", table: "tract_count" },
  { rule: "count_tract_geoid", table: "tract_count" },
  { rule: "nonnegative_count", table: "tract_count" },
];

export async function answerDataQuality(z: QueryClient, usesCounts: boolean): Promise<AnswerDataQuality> {
  const out: AnswerDataQuality = {
    status: "unavailable",
    checked_at: new Date().toISOString(),
    model: TRACT_MODEL,
    results: [],
  };
  try {
    // The rules are independent, so Zetaris runs them side by side.
    out.results = await Promise.all(
      RULES.filter((r) => usesCounts || r.table === "tract").map(async ({ rule, table }) => {
        const r = await z.query(`RUN DQ ${rule} TABLE ${TRACT_MODEL}.${table}`, 10);
        const row = Object.fromEntries(r.headers.map((h, i) => [h, r.rows[0]?.[i]]));
        const total = Number(row.total_record),
          valid = Number(row.valid_record),
          invalid = Number(row.invalid_record);
        if (![total, valid, invalid].every(Number.isFinite))
          throw new Error(`Zetaris returned no counts for ${rule} on ${table}`);
        return { rule, table, type: String(row.type ?? ""), total, valid, invalid };
      }),
    );
    out.status = out.results.every((r) => r.invalid === 0 && r.valid === r.total) ? "passed" : "failed";
  } catch (error) {
    out.results = [];
    out.message = error instanceof Error ? error.message : "Data-quality check failed";
  }
  return out;
}
