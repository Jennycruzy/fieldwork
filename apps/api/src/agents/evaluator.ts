import {
  VerdictSchema,
  runChecks,
  analysisChecks,
  notice,
  type CheckResult,
  type Plan,
  type Verdict,
} from "@fieldwork/core";
import { shared, provenance, systemBase, tractsTable, MAX_TRACTS, dataBlock, type Ctx } from "./context.js";
import type { Bridged } from "./bridge.js";
import type { Joined } from "./joiner.js";
import type { Wired } from "./wirer.js";

export interface Evaluation {
  verdict: Verdict;
  checks: CheckResult[];
}

// Code checks first; the model then judges whether the result answers the question, and can send work back.
export async function evaluate(
  ctx: Ctx,
  question: string,
  p: Plan,
  wired: Wired[],
  bridged: Bridged[],
  joined: Joined,
  round: number,
): Promise<Evaluation> {
  const codeStarted = Date.now();
  const b = bridged.reduce(
    (acc, x) => ({
      matched: acc.matched + x.matched,
      total: acc.total + x.total,
      unmatched: acc.unmatched + x.unmatched,
      invalid: acc.invalid + x.invalid,
    }),
    { matched: 0, total: 0, unmatched: 0, invalid: 0 },
  );
  const zeroColumns: string[] = [];
  let zeroProof: CheckResult | undefined;
  if (
    p.geography === "tract" &&
    /\b(no|zero|without)\b/i.test(question) &&
    bridged.length === 1 &&
    !wired.find((w) => w.label === bridged[0]!.label)?.capped
  ) {
    const source = bridged[0]!;
    const all = await ctx.zetaris.query(`SELECT geoid,name FROM ${tractsTable(ctx)}`, MAX_TRACTS);
    const present = await ctx.zetaris.query(
      `SELECT geoid FROM fw_pg.tract_counts WHERE run_id='${ctx.runId}' AND source='${source.label}' AND grp='all' AND n>0`,
      MAX_TRACTS,
    );
    const positive = new Set(present.rows.map((r) => r[0]));
    const expected = all.rows
      .filter((r) => !positive.has(r[0]))
      .map((r) => r[0])
      .sort();
    const j = joined.result.headers.findIndex((h) => /^(geoid|tractfips)$/i.test(h));
    const actual = joined.result.rows.map((r) => r[j]).sort();
    const verified = j >= 0 && source.matched > 0 && JSON.stringify(actual) === JSON.stringify(expected);
    zeroProof = {
      id: "zero_membership",
      ok: verified,
      detail: verified
        ? "Zero-count tracts exactly match the complete tract list minus tracts with located source records."
        : "Zero-count tract membership did not match independent source counts.",
    };
    if (verified)
      joined.result.headers.forEach((h, i) => {
        if (i > 0 && joined.result.rows.every((r) => r[i] != null && Number(r[i]) === 0)) zeroColumns.push(h);
      });
  }
  const checks = runChecks({
    verifiedZeroColumns: zeroColumns,
    bridge: bridged.length ? b : undefined,
    sourceCounts: wired.map((w) => ({
      label: w.label,
      source: w.sourceCount,
      zetaris: w.zetarisCount,
      capped: w.capped,
    })),
    resultRows: joined.result.rows.length,
    duplicatesRemoved: bridged.reduce((n, b) => n + b.duplicates, 0),
    minGroupSize:
      p.analysis?.basis === "rates"
        ? minimumDenominator(joined)
        : wired.some((w) => w.valueKind === "score")
          ? minimumSample(joined)
          : undefined,
    result: joined.result,
    years: p.years,
    today: ctx.today,
    excludedTestRecords: wired.reduce((n, w) => n + w.excludedTestRecords, 0),
  });
  if (zeroProof) checks.push(zeroProof);
  if (
    p.geography === "tract" &&
    p.output === "list" &&
    p.analysis?.basis === "counts" &&
    wired.length === 1 &&
    !/\b(no|zero|without)\b/i.test(question) &&
    bridged.length === 1 &&
    !wired.find((w) => w.label === bridged[0]!.label)?.capped
  ) {
    const source = bridged[0]!;
    const present = await ctx.zetaris.query(
      `SELECT geoid FROM fw_pg.tract_counts WHERE run_id='${ctx.runId}' AND source='${source.label}' AND grp='all' AND n>0`,
      MAX_TRACTS,
    );
    checks.push(positiveMembershipCheck(present.rows, joined.result));
  }
  for (const w of wired.filter((w) => w.valueKind === "score")) {
    checks.push({
      id: "latest_source_selection",
      ok: !/\bScore(?:_1)?\s*[<>=]/i.test(w.where),
      detail:
        "Retrieve full inspection histories before latest-per-establishment selection; apply score thresholds in the analysis only.",
    });
  }
  for (const w of wired) {
    if (w.accessedAt)
      checks.push({
        id: `source_accessed_${w.label}`,
        ok: true,
        detail: `${w.title}: retrieved ${w.accessedAt.slice(0, 10)}. Catalog updated ${w.catalogUpdatedAt?.slice(0, 10) ?? "date not published"}; retrieval is not an event or inspection date.`,
      });
    for (const [field, definition] of Object.entries(w.fieldDefinitions ?? {}))
      checks.push({
        id: "source_field_" + w.label + "_" + field,
        ok: true,
        detail: w.title + " — " + field + ": " + definition,
      });
    if (w.catalogDescription)
      checks.push({
        id: `source_definition_${w.label}`,
        ok: true,
        detail: `Published description for ${w.title}: ${w.catalogDescription}`,
      });
    if (w.valueField && /^Call_Count_By_Origin$/i.test(w.valueField))
      checks.push({
        id: `call_units_${w.label}`,
        ok: true,
        detail:
          "This table contains call-center activity summaries, including emergency and non-emergency call categories. Sum the published Call_Count_By_Origin values; do not count rows or add parallel provider totals. These calls are not confirmed incidents and do not measure crime rates.",
      });
  }
  for (const w of wired.filter((w) => w.coverage)) {
    const c = w.coverage!;
    const period = (value: number | null) =>
      value == null ? "unknown" : `${Math.floor(value / 100)}-${String(value % 100).padStart(2, "0")}`;
    const expected = expectedMonths(p.years, c, ctx.today);
    checks.push({
      id: `source_dates_${w.label}`,
      ok: true,
      detail: `${w.title}: event dates ${c.earliest ?? "not published"} to ${c.latest ?? "not published"}; monthly coverage ${period(c.firstPeriod)} through ${period(c.lastPeriod)} (${c.periods} distinct months).${expected && c.periods < expected ? ` Only ${c.periods} calendar months contain records; ${expected - c.periods} ${expected - c.periods === 1 ? "month has" : "months have"} no source rows. Complete annual coverage is not established; absent months are not confirmed zeros.` : ""}`,
    });
  }
  checks.push(...analysisChecks(p, joined.sql, joined.result));
  for (const w of wired.filter((w) => w.normalized && w.valueKind === "score")) {
    const observed = await ctx.zetaris.query(
      `SELECT geoid,entity_key,event_date,value,record_id FROM fw_pg.tract_observations WHERE run_id='${ctx.runId}' AND source='${w.label}'`,
      10000,
    );
    checks.push(latestInspectionCheck(question, observed.rows, joined.result));
  }
  if (p.analysis?.relationship) {
    const health =
      wired.find(
        (w) =>
          w.shape === "socrata_list" &&
          w.fields.includes("tractfips") &&
          w.fields.some((f) => f.endsWith("_crudeprev")),
      ) ?? wired.find((w) => w.shape === "socrata_list" && w.fields.includes("tractfips"));
    if (health) {
      const fields = health.fields.filter((f) =>
        /^(tractfips|totalpopulation|totalpop18plus)$|^[a-z0-9_]+_crudeprev$/.test(f),
      );
      const source = await ctx.zetaris.query(
        `SELECT ${fields.join(",")} FROM session.${health.tables[0]}`,
        1000,
      );
      checks.push(pairedMembershipCheck(source.headers, source.rows, joined.result, p.analysis.denominator));
    }
  }
  if (
    p.geography === "city" &&
    wired.length === 1 &&
    wired[0]?.normalized &&
    /category|type|kind|grp/i.test(joined.result.headers[0] ?? "")
  ) {
    const w = wired[0];
    const source = await ctx.zetaris.query(
      `SELECT category,SUM(value) FROM fw_pg.tract_observations WHERE run_id='${ctx.runId}' AND source='${w.label}' GROUP BY category`,
      10000,
    );
    checks.push(categoryTotalsCheck(source.rows, joined.result));
  }
  for (const c of checks)
    await ctx.trace.log({
      agent: "evaluator",
      action: `check:${c.id}`,
      status: c.ok ? "ok" : "error",
      note: c.detail,
    });

  for (const [id, code] of [
    ["bridge_match", "JOIN_WEAK"],
    ["sample_size", "SMALL_SAMPLE"],
  ] as const) {
    const c = checks.find((c) => c.id === id && !c.ok);
    if (c)
      await ctx.trace.log({
        agent: "evaluator",
        action: code,
        status: "info",
        note: notice(code, c.detail).message,
      });
  }
  await ctx.trace.log({
    agent: "evaluator",
    action: "code_checks",
    status: "info",
    latencyMs: Date.now() - codeStarted,
    note: "Independent code-check wall time, including source queries.",
  });
  const failed = checks.filter((c) => !c.ok);
  const rowsPreview = [joined.result.headers, ...joined.result.rows.slice(0, 12)]; // enough to judge; fewer tokens keeps the Evaluator fast
  const { value } = await ctx.models.evaluator.json(
    [
      {
        role: "system",
        content: `${systemBase(ctx)}
You are the Evaluator. Challenge the work before anyone sees it. Decide APPROVE or REVISE.
Filters listed under sources_as_wired are already applied before the SQL runs; do not ask for them again.
Coverage, partial periods and retrieval-date limits reported by passing code checks are disclosure requirements for the Writer; code appends the coverage caveat. Do not replan, rewire or revise SQL solely to add these notes.
sample_size is a warning about interpretation, not an incorrect aggregate. When each row exposes its establishment count and sample_note flags small groups, keep the complete cohort. Return APPROVE with target null when the result is correct; put the disclosure in your verdict.reasons for the Writer. Do not send a plan revision merely to add warning prose. Do not invent a minimum group size or suppress valid groups merely to remove that warning. Actual failed accuracy checks still require repair.
REVISE (with one concrete instruction) when: the result does not answer the question asked; a needed column is missing; the comparison is unfair (e.g. raw counts where tracts differ a lot in population and the question implies a rate); the time filter does not match the plan; or a code check failed and the SQL can fix it.
target "join" = the SQL must change; "wire" = a dataset filter or field must change; "plan" = the wrong data was chosen.
Check the plan analysis: state whether counts or rates answer the question and why in reasons. Relationships must compare population-adjusted city rates with health prevalence, not estimated adult counts. Check denominator labels against SQL (totalpopulation means residents; totalpop18plus means adults), full paired-set size before display limits, and ORDER BY the requested ranking measure. A repeated correlation value is one statistic, not independent confirmation in every row. Check missing values and zero counts separately.
Be brief: judge, do not re-derive the whole analysis. This is round ${round} of at most 3; on round 3 approve unless the answer would be wrong, and list the limits instead.
Shape: {"verdict": "APPROVE" | "REVISE", "target": "join" | "wire" | "plan" | null, "instruction": "..." | null, "reasons": ["short reasons"]}`,
      },
      {
        role: "user",
        content:
          shared(ctx) +
          `Question: ${question}\n` +
          dataBlock("plan", p) +
          "\n" +
          dataBlock(
            "sources_as_wired",
            [
              `${tractsTable(ctx)}: all ${ctx.cfg.place.countyName} County, ${ctx.cfg.place.stateAbbr} census tracts (state ${ctx.cfg.place.stateFips}, county ${ctx.cfg.place.countyFips}); already county-scoped`,
              ...wired.map(
                (w) =>
                  `${w.label} = "${w.title}": filtered AT THE SOURCE with ${w.where}; ${w.zetarisCount} records${w.shape === "arcgis_features" || w.shape === "epa_facilities" ? "; counted per tract into fw_pg.tract_counts (run_id/source columns only identify this run's counts)" : ""}`,
              ),
            ].join("\n"),
          ) +
          "\n" +
          dataBlock("sql", joined.sql) +
          "\n" +
          dataBlock("result_preview", rowsPreview) +
          "\n" +
          dataBlock("code_checks", checks) +
          (failed.length ? `\nFailed code checks: ${failed.map((f) => f.id).join(", ")}` : ""),
      },
    ],
    VerdictSchema,
    p.analysis?.relationship ? 4000 : 2000,
  );
  // An empty measure is never a valid answer, whatever the model thinks: the join goes back with the reason.
  const empty = blockingCheck(checks);
  if (empty) {
    value.verdict = "REVISE";
    value.target =
      empty.id === "analysis_basis"
        ? "plan"
        : empty.id === "latest_source_selection" ||
            (empty.id === "has_rows" && wired.some((w) => w.sourceCount === 0))
          ? "wire"
          : "join";
    value.instruction = `${empty.detail}. Check the join keys and filter values against the table descriptions (for tract_counts, grp = 'all' is the total per tract).`;
    value.reasons = [empty.detail, ...value.reasons].slice(0, 6);
  }
  if (ctx.world) {
    const source = provenance(ctx, "evaluator");
    await ctx.world.upsertContext({
      type: "round",
      externalKey: { system: ctx.runId, id: String(round) },
      attrs: { verdict: value.verdict, checks },
      source,
    });
    const f = ctx.world.entities().find((e) => e.type === "finding" && e.id.endsWith(":query"));
    const decision = await ctx.world.upsertEntity({
      type: value.verdict === "REVISE" ? "challenge" : "finding",
      externalKey: {
        system: ctx.runId,
        id: value.verdict === "REVISE" ? String(round) : `approval-${round}`,
      },
      attrs: {
        round,
        status: value.verdict === "REVISE" ? "open" : "approved",
        instruction: value.instruction,
        reasons: value.reasons,
      },
      source,
    });
    if (f)
      await ctx.world.relate({
        from: decision.id,
        type: value.verdict === "REVISE" ? "contradicts" : "supports",
        to: f.id,
        source,
      });
  }
  await ctx.trace.log({
    agent: "evaluator",
    action: "verdict",
    status: value.verdict === "APPROVE" ? "ok" : "info",
    note:
      value.verdict === "APPROVE"
        ? `Approved: ${value.reasons.join("; ")}`
        : `Sent back to the ${value.target ?? "join"}: ${value.instruction ?? value.reasons.join("; ")}`,
  });
  return { verdict: value, checks };
}

function minimumDenominator(joined: Joined): number | undefined {
  const j = joined.result.headers.findIndex((h) =>
    /^(population|total_population|totalpopulation|totalpop18plus|resident_population|adult_population|denominator|sample_size)$/i.test(
      h,
    ),
  );
  const values =
    j < 0 ? [] : joined.result.rows.map((r) => (r[j] == null ? NaN : Number(r[j]))).filter(Number.isFinite);
  return values.length ? Math.min(...values) : undefined;
}

function minimumSample(joined: Joined): number | undefined {
  const j = joined.result.headers.findIndex((h) =>
    /establishment.*count|count.*establishment|sample_size|inspected_count/i.test(h),
  );
  const values =
    j < 0 ? [] : joined.result.rows.map((r) => (r[j] == null ? NaN : Number(r[j]))).filter(Number.isFinite);
  return values.length ? Math.min(...values) : undefined;
}

// Independently select latest establishments in code, then compare the grouped SQL output.
export function latestInspectionCheck(
  question: string,
  observations: (string | null)[][],
  result: { headers: string[]; rows: (string | null)[][] },
): CheckResult {
  const latest = new Map<string, (string | null)[]>();
  for (const row of observations) {
    const old = latest.get(row[1]!);
    if (
      !old ||
      String(row[2] ?? "") > String(old[2] ?? "") ||
      (row[2] === old[2] && String(row[4]) > String(old[4]))
    )
      latest.set(row[1]!, row);
  }
  const groups = new Map<string, number[]>();
  for (const row of latest.values())
    if (row[0] && row[3] != null) {
      const a = groups.get(row[0]) ?? [];
      a.push(Number(row[3]));
      groups.set(row[0], a);
    }
  const { headers, rows } = result,
    geo = headers.findIndex((h) => /^(geoid|tractfips)$/i.test(h));
  const threshold = question.match(/\b(?:below|less than|under)\s+(\d+(?:\.\d+)?)/i)?.[1];
  const measure = headers.findIndex((h) =>
    threshold ? /below|threshold/i.test(h) : /avg|average|mean/i.test(h),
  );
  const count = headers.findIndex((h) =>
    threshold
      ? /total.*(?:inspect|establish)/i.test(h)
      : /establishment.*count|facility_count|sample|^n$/i.test(h),
  );
  const actual = new Set(rows.map((r) => r[geo]));
  const ok =
    observations.length < 10000 &&
    geo >= 0 &&
    measure >= 0 &&
    count >= 0 &&
    rows.length > 0 &&
    [...groups.keys()].every((k) => actual.has(k)) &&
    rows.every((r) => {
      const scores = groups.get(r[geo] ?? "") ?? [];
      const expected = threshold
        ? scores.filter((v) => v < Number(threshold)).length
        : scores.reduce((a, b) => a + b, 0) / scores.length;
      return Number(r[count]) === scores.length && Math.abs(Number(r[measure]) - expected) < 1e-5;
    });
  return {
    id: "latest_inspection_values",
    ok,
    detail: ok
      ? "Latest-per-establishment scores, sample sizes and thresholds independently recompute from normalized inspection histories."
      : "Latest inspection output did not match independently selected establishment scores; select latest before excluding missing scores or applying thresholds.",
  };
}

export function pairedMembershipCheck(
  headers: string[],
  source: (string | null)[][],
  result: { headers: string[]; rows: (string | null)[][] },
  denominator: string,
): CheckResult {
  const pop = headers.indexOf(denominator === "adults" ? "totalpop18plus" : "totalpopulation"),
    geo = headers.indexOf("tractfips");
  const metrics = headers
    .map((h, j) => ({ h, j }))
    .filter(({ h }) => h.endsWith("_crudeprev"))
    .filter(({ h }) => {
      const name = h.replace(/_crudeprev$/, "");
      const re =
        name === "bphigh"
          ? /blood|hypertens|(?:^|_)bp(?:_|$)/i
          : name === "casthma"
            ? /asthma/i
            : new RegExp(name, "i");
      return result.headers.some((v) => !/corr/i.test(v) && re.test(v));
    });
  const expected = new Set(
    source
      .filter(
        (r) =>
          pop >= 0 &&
          r[pop] != null &&
          Number(r[pop]) > 0 &&
          metrics.every(({ j }) => r[j] != null && r[j] !== "" && Number.isFinite(Number(r[j]))),
      )
      .map((r) => r[geo]),
  );
  const actualGeo = result.headers.findIndex((h) => /^(geoid|tractfips)$/i.test(h)),
    actual = result.rows.map((r) => r[actualGeo]);
  const ok =
    geo >= 0 &&
    pop >= 0 &&
    actualGeo >= 0 &&
    expected.size > 0 &&
    actual.length === expected.size &&
    new Set(actual).size === actual.length &&
    actual.every((id) => expected.has(id));
  return {
    id: "paired_membership",
    ok,
    detail: ok
      ? `All ${expected.size} population-eligible tracts appear exactly once in the paired result.`
      : `Expected ${expected.size} eligible tracts but returned ${actual.length}. Start with the complete non-missing population/health cohort, LEFT JOIN complete event totals and retain verified zero event counts.`,
  };
}
export function categoryTotalsCheck(
  source: (string | null)[][],
  result: { headers: string[]; rows: (string | null)[][] },
): CheckResult {
  const count = result.headers.findIndex((h) => /count|requests|^n$/i.test(h) && !/total/i.test(h));
  const expected = new Map(source.map((r) => [r[0], Number(r[1])]));
  const ok =
    source.length < 10000 &&
    count >= 0 &&
    result.rows.length === expected.size &&
    new Set(result.rows.map((r) => r[0])).size === expected.size &&
    result.rows.every((r) => Number(r[count]) === expected.get(r[0]));
  return {
    id: "category_totals",
    ok,
    detail: ok
      ? `All ${expected.size} category totals match the independently aggregated source observations.`
      : `The source has ${expected.size} categories; return every category and its correct weighted total before describing shares or ranks.`,
  };
}

const BLOCKING = [
  "has_rows",
  "measure_values",
  "analysis_basis",
  "relationship_rates",
  "ranking_order",
  "zero_membership",
  "positive_membership",
  "latest_source_selection",
  "latest_inspection_values",
  "paired_membership",
  "category_totals",
];
// The first failed check that no model verdict can override.
export function blockingCheck(checks: CheckResult[]): CheckResult | undefined {
  return checks.find((c) => (BLOCKING.includes(c.id) || c.id.startsWith("rate_arithmetic_")) && !c.ok);
}

export function positiveMembershipCheck(
  source: (string | null)[][],
  result: { headers: string[]; rows: (string | null)[][] },
): CheckResult {
  const geo = result.headers.findIndex((h) => /^(geoid|tractfips)$/i.test(h)),
    expected = new Set(source.map((r) => r[0]));
  const actual = result.rows.map((r) => r[geo]);
  const ok =
    geo >= 0 &&
    expected.size > 0 &&
    actual.length === expected.size &&
    new Set(actual).size === actual.length &&
    actual.every((id) => expected.has(id));
  return {
    id: "positive_membership",
    ok,
    detail: ok
      ? "Listed tracts exactly match the distinct tracts with positive independently counted source records."
      : "Return each tract with positive source counts exactly once; exclude tracts without listed records.",
  };
}

/** Months a single past calendar year should hold: from the plan, or from the source's own span when the plan names no years. */
export function expectedMonths(
  years: { from?: number | null; to?: number | null } | null | undefined,
  coverage: { firstPeriod: number | null; lastPeriod: number | null },
  today: Date,
): number | undefined {
  const current = today.getUTCFullYear();
  if (years?.from) return (!years.to || years.from === years.to) && years.from < current ? 12 : undefined;
  const { firstPeriod: first, lastPeriod: last } = coverage;
  if (first == null || last == null) return undefined;
  const year = Math.floor(first / 100);
  return year === Math.floor(last / 100) && year < current ? 12 : undefined;
}
