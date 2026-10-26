import type { Plan } from "./types.js";
import type { CheckResult } from "./checks.js";
// Check the units in the actual result as well as the declared plan.
export function analysisChecks(
  plan: Plan,
  sql: string,
  result: {
    headers: string[];
    rows: (string | null)[][];
  },
): CheckResult[] {
  const a = plan.analysis;
  const out: CheckResult[] = [];
  if (!a)
    return [
      {
        id: "analysis_basis",
        ok: false,
        detail: "Choose counts or rates, with a denominator and a reason before answering.",
      },
    ];
  out.push({
    id: "analysis_basis",
    ok:
      !!a.reason &&
      (["counts", "scores"].includes(a.basis) ? a.denominator === "none" : a.denominator !== "none"),
    detail: `${a.basis}; denominator: ${a.denominator}. ${a.reason}`,
  });
  if (a.relationship) {
    const rate = result.headers.findIndex(
      (h) => /per_?1000|per_?1_000|rate/i.test(h) && !/blood|bp|asthma|prevalence/i.test(h),
    );
    const corr = result.headers.findIndex((h) => /corr/i.test(h));
    const paired = result.headers.findIndex((h) => /paired_tracts/i.test(h));
    const correctLabel =
      rate >= 0 &&
      (a.denominator === "adults" ? /adult|18plus/i : /resident|total_?population/i).test(
        result.headers[rate]!,
      );
    const denom = a.denominator === "adults" ? /totalpop18plus/i : /totalpopulation/i;
    out.push({
      id: "relationship_rates",
      ok:
        a.basis === "rates" &&
        correctLabel &&
        denom.test(sql) &&
        /\//.test(sql) &&
        corr >= 0 &&
        paired >= 0 &&
        !/\bLIMIT\s+50\b/i.test(sql),
      detail:
        "Relationships need labeled per-resident or per-adult rates, the matching population field, correlation, and the full paired_tracts count before any display limit.",
    });
  }
  if (plan.output === "ranking") {
    const direction = /lowest|fewest|smallest|ascending/i.test(a.rank_measure) ? 1 : -1;
    const values = result.rows.map((r) => (r[1] == null ? NaN : Number(r[1])));
    const numeric = values.filter(Number.isFinite);
    const sorted = numeric.every((v, i) => i === 0 || direction * (v - numeric[i - 1]!) >= -1e-9);
    out.push({
      id: "ranking_order",
      ok: /\bORDER\s+BY\b/i.test(sql) && numeric.length > 0 && sorted,
      detail: `Sort by the requested measure: ${a.rank_measure}; retain its value before supporting columns.`,
    });
  }
  out.push(...rateArithmeticChecks(result));
  return out;
}

export function rateArithmeticChecks(result: {
  headers: string[];
  rows: (string | null)[][];
}): CheckResult[] {
  const { headers, rows } = result,
    out: CheckResult[] = [];
  const tokens = (s: string) =>
    s
      .toLowerCase()
      .split("_")
      .map((w) => w.replace(/s$/, ""))
      .filter(
        (w) =>
          ![
            "per",
            "1000",
            "10000",
            "rate",
            "resident",
            "adult",
            "count",
            "total",
            "population",
            "n",
          ].includes(w),
      );
  for (const [i, h] of headers.entries()) {
    if (/corr/i.test(h) || !/(?:^|_)per_?(?:1_?000|10_?000)|(?:^|_)rate(?:_|$)/i.test(h)) continue;
    if (/asthma|blood|diabet|prevalence|hypertens|crudeprev/i.test(h) && !/(?:^|_)per_/i.test(h)) continue;
    const scale = /10_?000/.test(h) ? 10000 : 1000;
    const adult = /adult|18plus/i.test(h);
    const denominator = headers.findIndex(
      (v) =>
        !/per_|rate|corr/i.test(v) &&
        (adult
          ? /adult_population|totalpop18plus|^adults$|denominator/i
          : /total_?population|resident_population|^population$|^residents$|denominator/i
        ).test(v),
    );
    // Any displayed count column may be the numerator ("code_violations", "violation_count", "n_311"), as long as
    // it reproduces every displayed rate. A tract with no events may show an empty count beside a 0 rate.
    const candidates = headers
      .map((v, j) => ({ j, v, score: tokens(v).filter((w) => tokens(h).includes(w)).length }))
      .filter(
        (x) =>
          x.j !== i &&
          !/per_|rate|corr|population|totalpop|prevalence|pct|percent|geoid|fips|paired|name/i.test(x.v) &&
          (/count|^n_|^n$/i.test(x.v) || x.score > 0),
      )
      .sort((a, b) => b.score - a.score);
    const reproduces = (numerator: number) =>
      denominator >= 0 &&
      rows.length > 0 &&
      rows.every((r) => {
        const n = r[numerator],
          d = r[denominator],
          actual = r[i];
        if (d == null || Number(d) <= 0) return actual == null;
        if (n == null) return actual != null && Number(actual) === 0;
        return actual != null && Math.abs(Number(actual) - (Number(n) / Number(d)) * scale) <= 1e-5;
      });
    const ok = candidates.some((c) => reproduces(c.j));
    out.push({
      id: `rate_arithmetic_${i}`,
      ok,
      detail: ok
        ? `${h}: recomputed every displayed rate from raw counts, its population denominator and scaling by ${scale}.`
        : `${h}: retain the raw count and matching population denominator and compute count * ${scale}.0 / population; missing or zero populations produce NULL.`,
    });
  }
  return out;
}
