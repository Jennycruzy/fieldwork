import { computeFigureLedger } from "./figures.js";
// The Evaluator's code checks. A run is approved only if these pass (or each failure is explained in the answer).

export interface CheckResult {
  id: string;
  ok: boolean;
  detail: string;
  locationAccounting?: { matched: number; total: number; unmatched: number; invalid: number };
}

export interface CheckInput {
  bridge?: { matched: number; total: number; unmatched: number; invalid: number };
  sourceCounts: { label: string; source: number; zetaris: number; capped: boolean }[];
  resultRows: number;
  verifiedZeroColumns?: string[];
  result?: { headers: string[]; rows: (string | null)[][] }; // to catch a measure that is 0 or empty everywhere
  minGroupSize?: number; // smallest count behind any rate in the result
  years?: { from?: number | null; to?: number | null } | null;
  today?: Date;
  excludedTestRecords?: number;
  duplicatesRemoved?: number;
}

export function runChecks(c: CheckInput): CheckResult[] {
  const out: CheckResult[] = [];

  if (c.bridge && c.bridge.total > 0) {
    const rate = c.bridge.matched / (c.bridge.total - c.bridge.invalid || 1);
    out.push({
      id: "bridge_match",
      locationAccounting: { ...c.bridge },
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

  // A numeric column that is 0 or empty in every row almost always means a join matched nothing.
  if (c.result && c.result.rows.length > 1) {
    const { headers, rows } = c.result;
    const empty = headers.filter((_, j) => {
      if (j === 0 || c.verifiedZeroColumns?.includes(headers[j]!)) return false;
      const vals = rows.map((r) => r[j] ?? null);
      const numeric = vals.every((v) => v === null || /^-?\d+(\.\d+)?$/.test(v));
      return numeric && vals.every((v) => v === null || Number(v) === 0);
    });
    out.push({
      id: "measure_values",
      ok: empty.length === 0,
      detail:
        empty.length === 0
          ? "every measure column has real values"
          : `${empty.join(", ")} is 0 or empty in every row: the join most likely matched nothing`,
    });
  }

  if (c.minGroupSize !== undefined) {
    out.push({
      id: "sample_size",
      ok: c.minGroupSize >= 30,
      detail:
        c.minGroupSize >= 30
          ? `every group has at least 30 records (smallest ${c.minGroupSize})`
          : `a group has only ${c.minGroupSize} records: flagged as small`,
    });
  }

  const partial = partialYear(c.years, c.today ?? new Date());
  if (partial) out.push({ id: "partial_period", ok: true, detail: partial });
  if (c.result) {
    const now = c.today ?? new Date(),
      y = c.result.headers.findIndex((h) => /^year$/i.test(h)),
      m = c.result.headers.findIndex((h) => /^month$/i.test(h));
    if (
      y >= 0 &&
      m >= 0 &&
      c.result.rows.some(
        (r) => Number(r[y]) === now.getUTCFullYear() && Number(r[m]) === now.getUTCMonth() + 1,
      )
    ) {
      const month = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ][now.getUTCMonth()];
      out.push({
        id: "partial_month",
        ok: true,
        detail:
          "Partial month: " +
          month +
          " " +
          now.getUTCFullYear() +
          " is so far through " +
          now.toISOString().slice(0, 10) +
          "; do not rank it against complete months.",
      });
    }
  }

  if (c.excludedTestRecords) {
    out.push({
      id: "test_records",
      ok: true,
      detail: `${c.excludedTestRecords} test records excluded from the city data`,
    });
  }
  if (c.duplicatesRemoved !== undefined)
    out.push({
      id: "duplicates",
      ok: true,
      detail: `${c.duplicatesRemoved} duplicate case IDs removed before tract counting.`,
    });
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

// `facts` are other numbers the run established and the Writer may quote (e.g. "15,103 of 15,439 records placed").
// Cells can be null (a LEFT JOIN row with no match), so every cell is read as possibly empty.
export function checkDraft(
  texts: string[],
  headers: string[],
  rows: (string | null)[][],
  facts: string[] = [],
): DraftCheck {
  // Values come from every column except the first (the row's name, e.g. "Census Tract 11").
  // A share and its percent are the same figure (0.601 and 60.1%).
  const nameCol = nameColumn(headers);
  const columns = valueColumns(headers);
  // Numbers the run itself established for quoting: the question's own numbers and the tract count.
  const quotable = new Set(
    facts.flatMap((f) => (/^Quotable numbers:/.test(f) ? numbersIn(f.replace(/\(.*$/, "")) : [])),
  );
  const cellValues = (records: (string | null)[][]) => {
    const result = new Set<string>();
    for (const row of records)
      for (const j of columns) {
        const value = row[j];
        if (value == null || !/^[-+]?\d+(?:\.\d+)?$/.test(value)) continue;
        const x = Number(value);
        result.add(normaliseNumber(value));
        if (/share|percent|pct|prevalence|prev|_rate$/i.test(headers[j]!) && Math.abs(x) <= 1)
          result.add(normaliseNumber(String(x * 100)));
        if (/share|percent|pct|prevalence|prev|_rate$/i.test(headers[j]!) && Math.abs(x) <= 100)
          result.add(normaliseNumber(String(x / 100)));
      }
    return result;
  };
  const values = cellValues(rows);
  for (const h of headers) for (const n of numbersIn(h)) values.add(n); // e.g. a "2025" column name
  for (const f of facts)
    for (const n of numbersIn(f.replace(/\b(?:countyfips|tractfips|geoid)\s*[:=]\s*['"]?\d+['"]?/gi, " ")))
      values.add(n);
  const monthColumn = headers.findIndex((h) => /^month$/i.test(h));
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const calendarRows = /^(year|month)$/i.test(headers[0] ?? "") && monthColumn >= 0;
  const names = rows.map((r) =>
    calendarRows
      ? (monthNames[Number(r[monthColumn]) - 1] ?? String(r[monthColumn] ?? ""))
      : tidyHyphens(String(r[nameCol] ?? "")),
  );
  // Group sizes a sentence may count: all rows, rows at zero, rows above zero, rows sharing one value.
  const cohorts = new Set<string>([String(rows.length)]);
  for (const j of columns) {
    const cells = rows
      .map((r) => r[j])
      .filter((v): v is string => v != null && /^-?\d+(?:\.\d+)?$/.test(v))
      .map(Number);
    cohorts.add(String(cells.filter((x) => x === 0).length));
    cohorts.add(String(cells.filter((x) => x > 0).length));
    const by = new Map<number, number>();
    for (const x of cells) by.set(x, (by.get(x) ?? 0) + 1);
    for (const n of by.values()) cohorts.add(String(n));
  }
  const ledger = computeFigureLedger(headers, rows);
  const missing: string[] = [];
  for (const original of texts) {
    const t = normaliseText(original);
    for (const sentence of t.split(/;|[!?]|\.(?=\s+[A-Z])/)) {
      const sentenceRows = names
        .map((name, i) => (name && mentions(sentence, name) ? i : -1))
        .filter((i) => i >= 0);
      let previousRows: number[] = [];
      for (const clause of rowClauses(sentence, names)) {
        const direct = names.map((name, i) => (mentions(clause, name) ? i : -1)).filter((i) => i >= 0);
        const named = direct.length ? direct : previousRows;
        if (direct.length) previousRows = direct;
        const allowed = named.length
          ? cellValues([...new Set([...named, ...sentenceRows])].map((i) => rows[i]!))
          : values;
        const content = withoutNames(
          spellNumbers(
            knownIdentifiers(
              clause,
              facts,
              names,
              new Map(
                headers.map((h, j) => [
                  h.toLowerCase(),
                  new Set((named.length ? named.map((i) => rows[i]!) : rows).map((r) => r[j] ?? "")),
                ]),
              ),
            ),
          ),
          names,
        )
          .replace(/\b\d+(?:st|nd|rd|th)\b/gi, " ")
          .replace(/\bper\s+(?:1,?000|10,?000)\b/gi, " ")
          .replace(
            /\b(the|all)\s+(\d+)(?=\s+(?:tracts|rows|areas)\b)/gi,
            (match, article: string, n: string) =>
              [
                rows.length,
                ...columns.flatMap((j) => [
                  rows.filter((r) => r[j] != null && Number(r[j]) > 0).length,
                  rows.filter((r) => r[j] != null && Number(r[j]) === 0).length,
                ]),
              ].includes(Number(n))
                ? article
                : match,
          )
          .replace(/\btop\s+(\d+)\b/gi, (match, n: string) => (Number(n) <= rows.length ? "top" : match))
          .replace(
            /\b(\d+)(?=\s+(?:of\s+\d+\s+)?(?:[A-Za-z-]+\s+){0,2}(?:tracts?|months?|rows?|areas?|categories|types)\b)/gi,
            (match, n: string) => (cohorts.has(String(Number(n))) ? " " : match),
          )
          .replace(
            /\b(?:of|out of)\s+(\d+)(?=\s+(?:[A-Za-z-]+\s+){0,2}(?:tracts?|months?|rows?|areas?|categories|types)\b)/gi,
            (match, n: string) => (cohorts.has(String(Number(n))) ? " " : match),
          )
          .replace(/\b(?:at\s+)?rank(?:ed|s|ing)?\s+(?:at\s+)?\d{1,3}\b/gi, " ranked ")
          .replace(/\b(\d+)\s+tied\s+at\s+(-?\d+(?:\.\d+)?)/gi, (match, n: string, value: string) =>
            rows.filter((r) => r[columns[0]!] != null && Number(r[columns[0]!]) === Number(value)).length ===
            Number(n)
              ? "tied at " + value
              : match,
          )
          .replace(/\bfor\s+311\s+requests\b/gi, (match) =>
            headers.some((h) => /request|311/i.test(h)) ? "for service requests" : match,
          )
          .replace(/\b911(?=\s+calls\b)/gi, () =>
            facts.some((f) => /\b911\b|Call_Count_By_Origin/.test(f)) ? "" : "911",
          )
          .replace(/\b311(?=\s+service\s+requests)/gi, () =>
            facts.some((f) => /\b311\b/.test(f)) ? "" : "311",
          );
        for (const raw of numberTokens(content)) {
          const n = normaliseNumber(raw);
          if (
            !allowed.has(n) &&
            !quotable.has(n) &&
            !isYear(n) &&
            !(named.length === 0 && isSmallCount(n)) &&
            !nearAny(raw, allowed) &&
            !ledger.some(
              (f) =>
                Number(f.value.toFixed((raw.split(".")[1] ?? "").length)) === Number(raw) &&
                ((f.kind === "count" &&
                  new RegExp(
                    "\\b" +
                      raw.replace(".", "\\.") +
                      "\\s+(?:(?:distinct|calendar|census|total)\\s+)?(?:tracts?|months?|rows?|areas?|categories|types)\\b",
                    "i",
                  ).test(content)) ||
                  (f.kind === "total" &&
                    /\b(total|sum|combined|together|across|recorded|accounted)\b/i.test(sentence) &&
                    (named.length === 0 ||
                      f.rows.length === rows.length ||
                      named.every((i) => f.rows.includes(i))))),
            ) &&
            !(
              derivedNumber(
                raw,
                headers,
                rows,
                named.length ? [...new Set([...named, ...sentenceRows])] : [],
                clause,
              ) &&
              (named.length === 0 ||
                /\b(total|sum|combined|difference|change|increas\w*|decreas\w*|overall|across|rose|fell|range\w*|drop\w*|gap|net|more|fewer|less|higher|lower|above|below)\b/i.test(
                  clause,
                ))
            )
          )
            missing.push(n);
        }
      }
    }
  }

  // Ranking words must match the row order. Rows come sorted by the query; tied values (same first
  // numeric column) share a rank, e.g. two tracts at 13.1% tie for 4th.
  const order: string[] = [];
  const keyCol = rows[0]
    ? rows[0].findIndex((v, i) => i !== nameCol && columns.includes(i) && /^-?\d+(\.\d+)?$/.test(v ?? ""))
    : -1;
  const rankOf = (idx: number): number => {
    if (keyCol < 0) return idx + 1;
    const v = rows[idx]![keyCol];
    return rows.findIndex((r) => r[keyCol] === v) + 1; // first row with the same value = shared rank
  };
  for (const original of texts) {
    const t = normaliseText(original);
    for (const m of t.matchAll(/\b(?:Census\s+)?Tract\s+(\d+(?:\.\d+)?)/gi)) {
      if (!names.some((n) => n && mentions("Census Tract " + m[1], n)))
        order.push("The tract identifier " + m[1] + " names no result row.");
    }
    if (unsupportedCertainty(t)) order.push(`"${t}" overstates what these descriptive rows establish`);
    for (const f of facts) {
      const partial = f.match(/^Partial month: ([A-Za-z]+) (\d{4})/);
      if (
        partial &&
        new RegExp("\\b" + partial[1] + "\\b", "i").test(t) &&
        /\b(highest|lowest|most|fewest|ranked|leads|led)\b/i.test(t)
      )
        order.push("A partial month cannot be ranked against complete months.");
      if (
        partial &&
        calendarRows &&
        !names.some((n) => mentions(t, n)) &&
        /\b(highest|lowest|most|fewest|ranked)\b/i.test(t)
      ) {
        const idx = names.findIndex((n) => n === partial[1]),
          numbers = numbersIn(t);
        if (
          idx >= 0 &&
          columns.some((j) => rows[idx]![j] != null && numbers.includes(normaliseNumber(rows[idx]![j]!)))
        )
          order.push("A partial month's value cannot be ranked against complete months.");
      }
    }
    if (/\baccount\w*\b.*%.*\bgap\b/i.test(t))
      order.push("A claimed share of an extreme gap has no supplied formula for that cohort.");
    if (UNIVERSAL.test(t) && PATTERN.test(t) && !verifiedMetadata(t, headers, rows, facts))
      order.push(
        `"${t}" says the pattern holds in every row; the rows don't show that, so describe the overall tendency instead`,
      );
    const statedGroup = spellNumbers(t).match(
      /\b(\d+)\s+(?:Montgomery\s+)?(?:census\s+)?tracts\s+(?:(?:are|were)\s+)?(?:tie|tied|share)\b/i,
    );
    if (statedGroup && keyCol >= 0) {
      const members = names.map((name, i) => (mentions(t, name) ? i : -1)).filter((i) => i >= 0);
      const statedValue = t.match(/\bat\s+(-?\d+(?:\.\d+)?)(?![\w.])/i)?.[1];
      const rank = claimedRank(t);
      const row =
        members[0] ??
        (statedValue !== undefined
          ? rows.findIndex((r) => r[keyCol] != null && Number(r[keyCol]) === Number(statedValue))
          : rank !== undefined
            ? rows.findIndex((_, i) => rankOf(i) === rank)
            : -1);
      if (row >= 0) {
        const value = rows[row]![keyCol],
          size = rows.filter((r) => r[keyCol] === value).length;
        if (Number(statedGroup[1]) !== size || members.some((i) => rows[i]![keyCol] !== value))
          order.push("The stated tie-group size or named members do not match the primary measure.");
      }
    }
    const cohortTie = spellNumbers(t).match(
      /\b(?:all\s+)?(\d+)\s+(?:zero-[a-z]+\s+)?(?:Montgomery\s+)?(?:census\s+)?tracts\b/i,
    );
    if (
      cohortTie &&
      !names.some((n) => mentions(t, n)) &&
      !/[;!?]|\.(?=\s+[A-Z])/.test(t) &&
      /zero-|\bat 0\b|\b0 pharmacies/i.test(t) &&
      /rank|fewest/i.test(t)
    ) {
      const j = valueColumns(headers)[0],
        count = Number(cohortTie[1]);
      const zeros = j === undefined ? [] : rows.filter((r) => r[j] != null && Number(r[j]) === 0);
      const claim = claimedRank(t) ?? 1;
      const ascending = /ascending|fewest|lowest/i.test(t),
        explicitDirection = /ascending|descending|fewest|lowest|most|highest/i.test(t);
      const rank = explicitDirection
        ? 1 + rows.filter((r) => r[j!] != null && (ascending ? Number(r[j!]) < 0 : Number(r[j!]) > 0)).length
        : 1 + rows.findIndex((r) => r[j!] != null && Number(r[j!]) === 0);
      if (count !== zeros.length || claim !== rank)
        order.push("The stated zero-valued tie group size or rank does not match the rows.");
      continue;
    }
    if (/\b(tied|tie|ties|sharing|share|shares)\b/i.test(t)) {
      for (let i = 0; i < names.length; i++)
        if (mentions(t, names[i]!)) {
          const errors = columnRankProblems(t, i, names, headers, rows);
          if (errors) order.push(...errors);
          else {
            const rank = claimedRank(t);
            if (rank !== undefined && rank !== rankOf(i))
              order.push(`The stated tie for ${names[i]} is not supported by its actual rank.`);
          }
        }
    }
    if (/\b(tied|tie|ties|sharing|share|shares)\b/i.test(t)) continue;
    for (const sentence of t.split(/;|[!?]|\.(?=\s+[A-Z])/)) {
      if (/\b(?:excluded|filtered out)\b/i.test(sentence) && /\bfewer than\s+\d+/i.test(sentence)) {
        const threshold = Number(sentence.match(/fewer than\s+(\d+)/i)?.[1]);
        const j = headers.findIndex((h) => /establishment.*count|group.*size/i.test(h));
        if (j < 0 || rows.some((r) => r[j] == null || Number(r[j]) < threshold))
          order.push("The stated exclusion threshold is contradicted by the rows.");
        continue;
      }
      // Extreme-to-extreme arithmetic has no ordinal claim about an individual row.
      if (
        /\bhighest\b/i.test(sentence) &&
        /\blowest\b/i.test(sentence) &&
        /\b(gap|above|below|difference|change)\b/i.test(sentence) &&
        !names.some((n) => mentions(sentence, n))
      )
        continue;
      let previous = -1;
      for (const clause of rowClauses(sentence, names)) {
        const named = names.findIndex((n) => n && mentions(clause, n));
        const said = named < 0 ? previous : named;
        if (named >= 0) previous = named;
        // A rank claim next to one of the row's own values is checked against that value's column
        // ("the highest blood pressure rate at 59.2%" -> rank of 59.2 in its column), not the row order.
        if (said >= 0 || /\b(highest|lowest|most|fewest|largest|smallest)\b/i.test(clause)) {
          const byColumn = columnRankProblems(clause, said, names, headers, rows);
          if (byColumn) {
            order.push(...byColumn);
            continue;
          }
        }
        const claimed = claimedRankDir(clause)?.rank;
        if (said < 0) {
          const cohort = spellNumbers(clause).match(
            /\b(?:all\s+)?(\d+)\s+(?:Montgomery\s+)?(?:census\s+)?tracts\b/i,
          );
          if (
            claimed !== undefined &&
            /\ball\b/i.test(clause) &&
            (!cohort || Number(cohort[1]) === rows.length) &&
            rows.length > 0 &&
            rows.every((_, i) => rankOf(i) === claimed)
          )
            continue;
          // A rank claim about no row in particular ("eleven tracts share the third-highest rate") can't be checked.
          if (claimed !== undefined && !/top \w+ tracts? (by|are)|^the top/i.test(clause))
            order.push(`"${clause}" makes a ranking claim that names no row`);
          continue;
        }
        if (claimed !== undefined && claimed !== rankOf(said)) {
          order.push(
            `"${clause}" puts ${names[said]} at rank ${claimed}, but in the rows it is rank ${rankOf(said)}`,
          );
        }
      }
    }
  }
  return {
    ok: missing.length === 0 && order.length === 0,
    missingNumbers: [...new Set(missing)],
    orderProblems: order,
  };
}

// Keep each named row with its own claims. Unnamed following clauses inherit that row.
function rowClauses(text: string, names: string[]): string[] {
  return clauses(text).flatMap((clause) => {
    const starts = new Set<number>();
    for (const name of names) {
      if (!name) continue;
      const short = name.replace(/^Census\s+/i, "");
      const escaped = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?<![\\w.])(?:${escaped(name)}|${escaped(short)})(?!\\w|\\.\\d)`, "gi");
      for (const m of clause.matchAll(re)) starts.add(m.index!);
    }
    const cuts = [...starts]
      .sort((a, b) => a - b)
      .slice(1)
      .map((pos) => {
        const prefix = clause
          .slice(0, pos)
          .match(/(?:the\s+)?(?:first|second|third|fourth|fifth|\d+(?:st|nd|rd|th))-ranked\s*$/i);
        return prefix ? pos - prefix[0].length : pos;
      });
    return [0, ...cuts].map((start, i, all) => clause.slice(start, all[i + 1]));
  });
}

// Derived claims need a reproducible operation within one numeric measure column: the column total, or a
// difference or percent change between the rows the sentence names (between the highest, lowest, first and
// last rows when it names none). Any pair of 71 rows would make almost every small number "derived".
function derivedNumber(
  text: string,
  headers: string[],
  rows: (string | null)[][],
  named: number[] = [],
  context = "",
): boolean {
  const target = Number(text),
    places = (text.split(".")[1] ?? "").length;
  const equal = (x: number) =>
    Number.isFinite(x) &&
    (Number(x.toFixed(places)) === target ||
      (target > 0 &&
        /decreas|drop|fell|fewer|less/i.test(context) &&
        Number((-x).toFixed(places)) === target));
  for (const j of valueColumns(headers)) {
    const indexed = rows
      .map((r, i) => ({ i, v: r[j] }))
      .filter((x): x is { i: number; v: string } => x.v != null && /^-?\d+(?:\.\d+)?$/.test(x.v))
      .map((x) => ({ i: x.i, v: Number(x.v) }));
    if (!indexed.length) continue;
    if (equal(indexed.reduce((a, b) => a + b.v, 0))) return true;
    const max = indexed.reduce((a, b) => (b.v > a.v ? b : a)),
      min = indexed.reduce((a, b) => (b.v < a.v ? b : a));
    const pool = named.length
      ? indexed.filter((x) => named.includes(x.i))
      : [max, min, indexed[0]!, indexed[indexed.length - 1]!];
    for (const a of pool)
      for (const b of pool) {
        if (equal(b.v - a.v) || (a.v !== 0 && equal(((b.v - a.v) / a.v) * 100))) return true;
      }
  }
  return false;
}

// The row's name column, found by its header; the first column otherwise.
function nameColumn(headers: string[]): number {
  const j = headers.findIndex((h) => /^(?:name|tract_name|tract|area_name|neighborhood)$/i.test(h));
  return j >= 0 ? j : 0;
}

function valueColumns(headers: string[]): number[] {
  const nameCol = nameColumn(headers);
  return headers
    .map((h, j) => ({ h, j }))
    .filter(
      ({ h, j }) => j !== nameCol && !/geoid|fips|identifier|(?:^|_)(?:id|year|month|name)(?:_|$)/i.test(h),
    )
    .map(({ j }) => j);
}

function numbersIn(s: string | null | undefined): string[] {
  return numberTokens(s).map(normaliseNumber);
}

function numberTokens(s: string | null | undefined): string[] {
  return (s ?? "").replace(/,(?=\d{3}\b)/g, "").match(/(?:(?<![\w.)\]%-])-)?\d+(?:\.\d+)?/g) ?? [];
}

function normaliseNumber(n: string): string {
  const x = Number(n);
  return Number.isInteger(x) ? String(x) : String(Number(x.toFixed(6)));
}

// "top 5", "3 tracts": small counting numbers are not data claims.
function isSmallCount(n: string): boolean {
  const x = Number(n);
  return Number.isInteger(x) && x >= 1 && x <= 10;
}

function isYear(n: string): boolean {
  const x = Number(n);
  return Number.isInteger(x) && x >= 1900 && x <= 2100;
}

// Rounding in text (13.7% for 13.65) is fine; a different number is not.
function nearAny(n: string, values: Set<string>): boolean {
  const x = Number(n);
  const places = (n.split(".")[1] ?? "").length;
  const tol = 0.5 * 10 ** -places;
  for (const v of values) if (Math.abs(Number(v) - x) <= tol + 1e-9) return true;
  return false;
}

const WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

function spellNumbers(t: string): string {
  return t.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b(?=\s+(?:Montgomery\s+)?(?:census\s+)?(?:listed\s+)?(tracts?|neighborhoods?|areas?|records?|shelters?|pharmacies|requests?|violations?|calls?|establishments?))/gi,
    (w) => String(WORDS[w.toLowerCase()]),
  );
}

// "Census Tract 11" or "Tract 11" in the text names a row; its number is not a value claim.
function withoutNames(t: string, names: string[]): string {
  let s = t;
  for (const n of names) {
    if (!n) continue;
    const short = n.replace(/^Census\s+/i, "");
    for (const name of [n, short]) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      s = s.replace(new RegExp(`(?<![\\w.])${escaped}(?!\\w|\\.\\d)`, "gi"), " ");
    }
  }
  return s;
}

function mentions(t: string, name: string): boolean {
  const escaped = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const short = name.replace(/^Census\s+/i, "");
  return [name, short].some((n) => new RegExp(`(?<![\\w.])${escaped(n)}(?!\\w|\\.\\d)`, "i").test(t));
}

// "in every row", "consistently", "without exception": claims a correlation can't support.
const UNIVERSAL =
  /\b(?:in|across|for) (?:every|each|all(?: the)?) (?:rows?|tracts?|cases?)\b|\bconsistently\b|\bwithout exception\b|\bholds? (?:across|for) (?:the )?(?:full|whole|entire) list\b/i;

const PATTERN =
  /correlat|associat|pattern|relationship|higher|lower|\bmore\b|fewer|increas|decreas|\brise|\brose|\bfall|\bfell|\btend/i;

// Dashes become "-"; "most recent" is about time, not rank; "ranked 1st through 5th" describes the order.
function tidyHyphens(s: string): string {
  return s.replace(/\s*-\s*(?=[A-Za-z])/g, "-");
}

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
// Dates are not data values: "October 25, 2026" keeps its month (a calendar row name), "2026-10-25" goes.
function normaliseText(original: string): string {
  return tidyHyphens(expandTractLists(spellNumbers(original)).replace(/[\u2010-\u2015\u2212]/g, "-"))
    .replace(/\b\d{4}-\d{2}(?:-\d{2})?(?:T[\d:.]+Z?)?\b/g, " ")
    .replace(new RegExp(`\\b(${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4})?`, "g"), "$1")
    .replace(/\bmost recent\b/gi, "latest")
    .replace(
      /\b(?:\d{1,2}(?:st|nd|rd|th)|first|second|third)\s+(?:through|to)\s+(?:\d{1,2}(?:st|nd|rd|th)|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/gi,
      "in order",
    );
}

// Splits a sentence into clauses that each carry at most one rank claim:
// "X ranked second in violations at 608.4 and second in blood pressure at 60.1%".
function clauses(t: string): string[] {
  return t.split(
    /;|,\s+(?=and\b|with\b|but\b)|\s+and\s+(?=(?:the\s+)?(?:highest|lowest|most|fewest|first|second|third|fourth|fifth|\d{1,2}(?:st|nd|rd|th))\b|(?:ranked|ranks|is)\b)/i,
  );
}

// For each clause with a rank word and a number that is one of the named row's values, the claimed rank must
// match the row's rank in that value's column (descending for highest/most, ascending for lowest/fewest;
// equal values share a rank). Returns undefined when no clause ties a rank to a column, so the caller falls
// back to the row order.
function columnRankProblems(
  t: string,
  said: number,
  names: string[],
  headers: string[],
  rows: (string | null)[][],
): string[] | undefined {
  const problems: string[] = [];
  let resolved = false;
  for (const c of clauses(t)) {
    const claim = claimedRankDir(c);
    // "follows" / "is next" describe the row order, which the row-order check covers.
    if (
      !claim ||
      !/\b(highest|lowest|most|fewest|largest|smallest)\b/i.test(c) ||
      /\b(follows|comes next|is next|runner-up)\b/i.test(c)
    )
      continue;
    const nums = numbersIn(withoutNames(spellNumbers(c), names));
    const row = said >= 0 ? rows[said]! : undefined;
    const cols = new Set<number>();
    const candidateRows = row ? [row] : rows;
    for (const candidate of candidateRows)
      for (const n of nums)
        for (const j of valueColumns(headers)) {
          const v = candidate[j];
          if (v != null && /^-?\d+(\.\d+)?$/.test(v) && roundsTo(Number(v), n)) cols.add(j);
        }
    if (cols.size === 0 && row && valueColumns(headers).length === 1) cols.add(valueColumns(headers)[0]!);
    if (cols.size === 0) continue;
    resolved = true;
    const ranks = [...cols].map((j) => {
      const mine = row
        ? Number(row[j])
        : Number(nums.find((n) => rows.some((r) => r[j] != null && roundsTo(Number(r[j]), n))));
      const vals = rows.map((r) => (r[j] === null ? NaN : Number(r[j]))).filter((x) => !Number.isNaN(x));
      return { j, rank: 1 + vals.filter((x) => (claim.dir === "desc" ? x > mine : x < mine)).length };
    });
    if (!ranks.some((r) => r.rank === claim.rank)) {
      const r = ranks[0]!;
      problems.push(
        `"${c.trim()}" puts ${said >= 0 ? names[said] : "the stated value"} at rank ${claim.rank}${claim.dir === "asc" ? " from the bottom" : ""}, but in the rows it is rank ${r.rank} by ${headers[r.j] ?? "that column"}`,
      );
    }
  }
  return resolved ? problems : undefined;
}

// True when the text's number is the cell rounded to the text's precision: 645.4 for 645.36, 59.2% for 0.592.
function roundsTo(x: number, text: string): boolean {
  const n = Number(text);
  const d = (text.split(".")[1] ?? "").length;
  const near = (value: number, target: number, places: number) =>
    Math.abs(value - target) <= 0.5 * 10 ** -places + 1e-9;
  return near(x, n, d) || near(x * 100, n, d) || near(x / 100, n, d);
}

export function claimedRankDir(t: string): { rank: number; dir: "asc" | "desc" } | undefined {
  const s = t.toLowerCase();
  const dir = /\b(lowest|fewest|least|smallest)\b/.test(s) ? "asc" : "desc";
  const r =
    claimedRank(t) ??
    (/\b(the highest|the most|the largest|the lowest|the fewest|the smallest)\b/.test(s) ? 1 : undefined);
  return r === undefined ? undefined : { rank: r, dir };
}

const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

// "follows" / "is next" = rank 2; "third-highest", "ranks fourth", "ties for third", "5th" = that rank; "leads" / "highest" = 1.
export function claimedRank(t: string): number | undefined {
  const s = t.toLowerCase();
  const explicit = s.match(/\brank(?:ed|s)?\s+(?:at\s+)?(\d+)\b/);
  if (explicit) return Number(explicit[1]);
  const ord = s.match(
    /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d{1,2}(?:st|nd|rd|th))\b(?:[\s-]*(?:highest|lowest|most|fewest|place|ranked))?/,
  );
  if (ord) {
    const w = ord[1]!;
    const n = ORDINALS[w] ?? Number(w.replace(/\D/g, ""));
    if (
      /\b(rank|ranks|ranked|ties?|tied|is|at|place|highest|lowest|most|fewest)\b/.test(s) &&
      n >= 1 &&
      n <= 1000
    )
      return n;
  }
  if (/\b(follows|comes next|is next|runner-up)\b/.test(s)) return 2;
  if (/\b(leads|led|has the highest|has the most|tops)\b/.test(s)) return 1;
  return undefined;
}

function knownIdentifiers(
  text: string,
  facts: string[],
  names: string[] = [],
  identifiers = new Map<string, Set<string>>(),
): string {
  text = text.replace(/\bnumeric suffix\s*\(e\.g\.,?\s*(\d+(?:\.\d+)?)\)/gi, (match, id: string) =>
    names.some((n) => n.toLowerCase() === `census tract ${id}`) ? "known tract identifier" : match,
  );
  return text.replace(
    /\b(countyfips|tractfips|geoid)\s*[:=]\s*['"]?(\d+)['"]?/gi,
    (match, field: string, id: string) => {
      const expression = new RegExp(`\\b${field}\\s*[:=]\\s*['"]?${id}['"]?`, "i");
      const known = identifiers.get(field.toLowerCase());
      return (known ? known.has(id) : facts.some((f) => expression.test(f))) ? " " : match;
    },
  );
}

function expandTractLists(text: string): string {
  text = text.replace(
    /\btracts\s*\((\d+(?:\.\d+)?(?:\s*,\s*\d+(?:\.\d+)?)+)\)/gi,
    (_, list: string) =>
      "tracts: " + (list.match(/\d+(?:\.\d+)?/g) ?? []).map((id) => "Census Tract " + id).join(" and "),
  );
  text = text.replace(/\bTracts?\s+(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)+)/gi, (_, list: string) =>
    list
      .split("/")
      .map((id) => "Census Tract " + id)
      .join(" and "),
  );
  return text.replace(
    /\b(?:Census\s+)?Tracts?\s*:?\s+(\d+(?:\.\d+)?(?:\s*(?:,\s*(?:and\s+)?|and)\s*\d+(?:\.\d+)?)+)/gi,
    (_, list: string) => (list.match(/\d+(?:\.\d+)?/g) ?? []).map((id) => `Census Tract ${id}`).join(" and "),
  );
}

function unsupportedCertainty(text: string): boolean {
  for (const clause of text.split(/\bbut\b|[;!?]|(?<=[.])\s+(?=[A-Z])/i)) {
    for (const match of clause.matchAll(
      /\b(causes?|caused|proves?|guarantees?|statistically significant|certain|conclusive)\b/gi,
    )) {
      const prior = clause.slice(0, match.index);
      const negated =
        /\b(?:does not|do not|cannot|can't|doesn't)\s+(?:establish|show|prove|demonstrate|imply|mean|confirm)\b[^;!?]*$/i.test(
          prior,
        ) || /\b(?:does|do|did|is|are)\s+not\s*$/i.test(prior);
      if (!negated) return true;
    }
  }
  return false;
}

function verifiedMetadata(
  text: string,
  headers: string[],
  rows: (string | null)[][],
  facts: string[],
): boolean {
  if (/correlat|pattern|relationship|higher|lower|consistently|without exception/i.test(text)) return false;
  const geo = headers.findIndex((h) => /^(geoid|tractfips)$/i.test(h));
  if (/\b(geoid|identifier|tract code)\b/i.test(text) && /\b(provided|included|shown|supplied)\b/i.test(text))
    return geo >= 0 && rows.every((r) => r[geo] != null && r[geo] !== "");
  return (
    /\bscore/i.test(text) &&
    /averag/i.test(text) &&
    headers.some((h) => /avg|average|mean/i.test(h)) &&
    facts.some((f) => /Latest-per-establishment.*independently recompute/i.test(f))
  );
}
export function supportedDraft<
  T extends { headline: string; points: string[]; how_sure: string; caveats: string[] },
>(draft: T, headers: string[], rows: (string | null)[][], facts: string[]): T {
  const supported = (text: string) => checkDraft([text], headers, rows, facts).ok;
  return {
    ...draft,
    headline: supported(draft.headline)
      ? draft.headline
      : "Some draft statements could not be verified; review the result rows and checks.",
    points: draft.points.filter(supported),
    caveats: draft.caveats.filter(supported),
    how_sure: supported(draft.how_sure)
      ? draft.how_sure
      : "Some draft statements could not be checked. Only supported statements are shown; review the flagged checks.",
  };
}

// Check atomic sentences, preserving valid prose when another sentence fails.
export function finalizeDraft<
  T extends { headline: string; points: string[]; how_sure: string; caveats: string[] },
>(draft: T, headers: string[], rows: (string | null)[][], facts: string[]) {
  const removed: string[] = [];
  const pass = (s: string) => checkDraft([s], headers, rows, facts).ok;
  const filter = (text: string) =>
    text
      .split(/(?<=[.!?])\s+(?=[A-Z])/)
      .filter((s) => {
        if (pass(s)) return true;
        removed.push(s);
        return false;
      })
      .join(" ");
  let headline = draft.headline;
  if (!pass(headline)) {
    removed.push(headline);
    const count = computeFigureLedger(headers, rows).find((f) => f.id === "row_count")!.value;
    const nc = nameColumn(headers),
      vc = valueColumns(headers)[0];
    const calendar = headers.findIndex((h) => /^month$/i.test(h));
    const name =
      calendar >= 0
        ? [
            "January",
            "February",
            "March",
            "April",
            "May",
            "June",
            "July",
            "August",
            "September",
            "October",
            "November",
            "December",
          ][Number(rows[0]?.[calendar]) - 1]
        : rows[0]?.[nc];
    const top =
      name && vc !== undefined
        ? " Result for " + name + ": " + headers[vc]!.replace(/_/g, " ") + " " + rows[0]![vc] + "."
        : "";
    // Prefer a checked sentence the Writer already wrote; then a plain sentence about the first row;
    // the row count only as a last resort.
    const usable = draft.points
      .flatMap((p) => p.split(/(?<=[.!?])\s+(?=[A-Z])/))
      .filter((s) => s.length > 20 && !/^(?:the result|result for)\b/i.test(s) && pass(s));
    // The headline leads with the top row: a checked sentence naming it, else a plain sentence built
    // from it, else any other checked sentence, and the row count only as a last resort.
    const runnerUp = /\b(?:second|third|fourth|fifth|next|followed|runner-up|lowest|fewest)\b/i;
    const first = name ? String(name) : "";
    const raw = vc !== undefined ? rows[0]?.[vc] : undefined;
    const n = raw == null ? NaN : Number(raw);
    const shown = Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : raw;
    const words = vc !== undefined ? headers[vc]!.replace(/_/g, " ").trim() : "";
    const phrase = /\bcount$/i.test(words)
      ? shown +
        " " +
        words
          .replace(/\s*count$/i, "")
          .replace(/y$/, "ie")
          .replace(/s?$/, "s")
      : words + " of " + shown;
    const sentences = [
      usable.find((s) => !!first && s.includes(first) && !runnerUp.test(s)),
      // Calendar rows are in date order, so their first row is not a leader.
      first && shown != null && calendar < 0 ? first + " comes first, with " + phrase + "." : undefined,
      ...usable.filter((s) => !runnerUp.test(s)),
    ].filter((x): x is string => !!x);
    const template = "The result contains " + count + " rows." + top;
    headline =
      sentences.find(pass) ?? (pass(template) ? template : "The result contains " + count + " rows.");
  }
  let answer = {
    ...draft,
    headline,
    points: withoutHeadline(draft.points.map(filter).filter(Boolean), headline),
    how_sure: filter(draft.how_sure),
    caveats: draft.caveats.map(filter).filter(Boolean),
  };
  // Some claims pass alone and fail beside the rest of the answer, such as a shared rank stated
  // without the rows it refers to. Drop each sentence the whole-answer check quotes.
  for (let round = 0; round < 3; round++) {
    const whole = checkDraft(
      [answer.headline, ...answer.points, answer.how_sure, ...answer.caveats],
      headers,
      rows,
      facts,
    );
    if (whole.ok) break;
    const quoted = whole.orderProblems.join(" ");
    const strip = (text: string) =>
      text
        .split(/(?<=[.!?])\s+(?=[A-Z])/)
        .filter((s) => {
          const claim = s.trim().replace(/[.!?]$/, "");
          if (!claim || !quoted.includes(claim)) return true;
          removed.push(s);
          return false;
        })
        .join(" ");
    const next = {
      ...answer,
      points: answer.points.map(strip).filter(Boolean),
      how_sure: strip(answer.how_sure),
      caveats: answer.caveats.map(strip).filter(Boolean),
    };
    if (JSON.stringify(next) === JSON.stringify(answer)) break;
    answer = next;
  }
  if (!answer.how_sure.trim())
    answer.how_sure =
      "These comparisons describe the published records and do not establish cause and effect.";
  return { draft: answer, removed };
}

export function figureLedgerForTexts(headers: string[], rows: (string | null)[][], texts: string[]) {
  const month = headers.findIndex((h) => /^month$/i.test(h)),
    name = nameColumn(headers);
  const names = rows.map((r) =>
    month >= 0
      ? ([
          "January",
          "February",
          "March",
          "April",
          "May",
          "June",
          "July",
          "August",
          "September",
          "October",
          "November",
          "December",
        ][Number(r[month]) - 1] ?? "")
      : String(r[name] ?? ""),
  );
  const groups = texts
    .filter((t) =>
      /difference|change|higher|lower|above|below|more|fewer|range|increas|decreas|combined|\bsum\b|\btotal\b/i.test(
        t,
      ),
    )
    .map((text) => {
      const t = normaliseText(text);
      return names.map((n, i) => (mentions(t, n) ? i : -1)).filter((i) => i >= 0);
    })
    .filter((g) => g.length > 1);
  return computeFigureLedger(headers, rows, groups);
}

// A point promoted to the headline is not repeated below it, unless it is the only point left.
function withoutHeadline(points: string[], headline: string) {
  const rest = points.filter((p) => p.trim() !== headline.trim());
  return rest.length ? rest : points;
}
