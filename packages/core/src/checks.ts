// The Evaluator's code checks. A run is approved only if these pass (or each failure is explained in the answer).

export interface CheckResult {
  id: string;
  ok: boolean;
  detail: string;
}

export interface CheckInput {
  bridge?: { matched: number; total: number; unmatched: number; invalid: number };
  sourceCounts: { label: string; source: number; zetaris: number; capped: boolean }[];
  resultRows: number;
  minGroupSize?: number; // smallest count behind any rate in the result
  years?: { from?: number | null; to?: number | null } | null;
  today?: Date;
  excludedTestRecords?: number;
}

export function runChecks(c: CheckInput): CheckResult[] {
  const out: CheckResult[] = [];

  if (c.bridge && c.bridge.total > 0) {
    const rate = c.bridge.matched / (c.bridge.total - c.bridge.invalid || 1);
    out.push({
      id: "bridge_match",
      ok: rate >= 0.9,
      detail: `${c.bridge.matched.toLocaleString("en-US")} of ${(c.bridge.total - c.bridge.invalid).toLocaleString("en-US")} located records fell inside a tract (${pct(rate)}); ${c.bridge.unmatched} outside, ${c.bridge.invalid} without a location`,
    });
  }

  for (const s of c.sourceCounts) {
    const ok = s.capped ? s.zetaris > 0 : s.zetaris === s.source;
    out.push({
      id: `rows_${s.label}`,
      ok,
      detail: s.capped
        ? `${s.label}: read ${s.zetaris.toLocaleString("en-US")} rows through Zetaris (source has ${s.source.toLocaleString("en-US")}; reading is paged)`
        : `${s.label}: Zetaris rows ${s.zetaris.toLocaleString("en-US")} vs source's own count ${s.source.toLocaleString("en-US")}`,
    });
  }

  out.push({ id: "has_rows", ok: c.resultRows > 0, detail: `${c.resultRows} result rows` });

  if (c.minGroupSize !== undefined) {
    out.push({
      id: "sample_size",
      ok: c.minGroupSize >= 30,
      detail: c.minGroupSize >= 30 ? `every group has at least 30 records (smallest ${c.minGroupSize})` : `a group has only ${c.minGroupSize} records: flagged as small`,
    });
  }

  const partial = partialYear(c.years, c.today ?? new Date());
  if (partial) out.push({ id: "partial_period", ok: true, detail: partial });

  if (c.excludedTestRecords) {
    out.push({ id: "test_records", ok: true, detail: `${c.excludedTestRecords} test records excluded from the city data` });
  }
  return out;
}

export function partialYear(years: CheckInput["years"], today: Date): string | undefined {
  const y = today.getUTCFullYear();
  if (years?.to === y || (years?.from === y && !years.to)) {
    return `${y} is still in progress: its figures are "so far" (to ${today.toISOString().slice(0, 10)}) and are not compared with full years without saying so`;
  }
  return undefined;
}

// Values that look like test data in status or type fields, e.g. CaseStatus = 'DEBUG_TEST' (seen live in Montgomery's data).
export function looksLikeTestValue(v: string): boolean {
  return /\b(test|debug|dummy|sample|delete\s*me)\b|_test\b|^test_|debug_/i.test(v);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

// The final check, on the Writer's draft: every number it states must be in the result rows,
// and when it describes a ranking, the order must match the rows.
export interface DraftCheck {
  ok: boolean;
  missingNumbers: string[];
  orderProblems: string[];
}

export function checkDraft(texts: string[], headers: string[], rows: string[][]): DraftCheck {
  const values = new Set<string>();
  for (const r of rows) for (const v of r) for (const n of numbersIn(v)) values.add(n);
  for (const h of headers) for (const n of numbersIn(h)) values.add(n); // e.g. a "2025" column name
  const missing: string[] = [];
  for (const t of texts) for (const n of numbersIn(t)) if (!values.has(n) && !isYearOrSmallOrdinal(n)) missing.push(n);

  // Ranking words: "X follows", "second", "next" must point at the row that comes next.
  const order: string[] = [];
  const names = rows.map((r) => r[0] ?? "");
  for (const t of texts) {
    const m = t.match(/^(.*?)\s+(follows|is second|ranks second|comes next|is next)\b/i);
    if (!m) continue;
    const said = names.findIndex((n) => n && m[1]!.includes(n));
    if (said > 1) order.push(`"${t}" calls ${names[said]} next, but row 2 is ${names[1]}`);
  }
  return { ok: missing.length === 0 && order.length === 0, missingNumbers: [...new Set(missing)], orderProblems: order };
}

function numbersIn(s: string): string[] {
  return (s.replace(/,(?=\d{3}\b)/g, "").match(/-?\d+(?:\.\d+)?/g) ?? []).map(normaliseNumber);
}

function normaliseNumber(n: string): string {
  const x = Number(n);
  return Number.isInteger(x) ? String(x) : String(Number(x.toFixed(6)));
}

function isYearOrSmallOrdinal(n: string): boolean {
  const x = Number(n);
  return (Number.isInteger(x) && x >= 1900 && x <= 2100) || (Number.isInteger(x) && x >= 1 && x <= 10);
}
