import type { Plan } from "./types.js";
import type { CheckResult } from "./checks.js";
// Check the units in the actual result as well as the declared plan.
export function analysisChecks(plan: Plan, sql: string, result: {
    headers: string[];
    rows: (string | null)[][];
}): CheckResult[] {
    const a = plan.analysis;
    const out: CheckResult[] = [];
    if (!a)
        return [{ id: "analysis_basis", ok: false, detail: "Choose counts or rates, with a denominator and a reason before answering." }];
    out.push({ id: "analysis_basis", ok: !!a.reason && (a.basis === "counts" ? a.denominator === "none" : a.denominator !== "none"), detail: `${a.basis}; denominator: ${a.denominator}. ${a.reason}` });
    if (a.relationship) {
        const rate = result.headers.findIndex((h) => /per_?1000|per_?1_000|rate/i.test(h) && !/blood|bp|asthma|prevalence/i.test(h));
        const corr = result.headers.findIndex((h) => /corr/i.test(h));
        const paired = result.headers.findIndex((h) => /paired_tracts/i.test(h));
        const correctLabel = rate >= 0 && (a.denominator === "adults" ? /adult/i : /resident/i).test(result.headers[rate]!);
        const denom = a.denominator === "adults" ? /totalpop18plus/i : /totalpopulation/i;
        out.push({ id: "relationship_rates", ok: a.basis === "rates" && correctLabel && denom.test(sql) && /\//.test(sql) && corr >= 0 && paired >= 0 && !/\bLIMIT\s+50\b/i.test(sql), detail: "Relationships need labeled per-resident or per-adult rates, the matching population field, correlation, and the full paired_tracts count before any display limit." });
    }
    if (plan.output === "ranking") {
        const direction = /lowest|fewest|smallest|ascending/i.test(a.rank_measure) ? 1 : -1;
        const values = result.rows.map((r) => r[1] == null ? NaN : Number(r[1]));
        const numeric = values.filter(Number.isFinite);
        const sorted = numeric.every((v, i) => i === 0 || direction * (v - numeric[i - 1]!) >= -1e-9);
        out.push({ id: "ranking_order", ok: /\bORDER\s+BY\b/i.test(sql) && numeric.length > 0 && sorted, detail: `Sort by the requested measure: ${a.rank_measure}; retain its value before supporting columns.` });
    }
    return out;
}
