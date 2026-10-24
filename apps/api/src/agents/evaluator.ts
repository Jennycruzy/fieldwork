import { VerdictSchema, runChecks, analysisChecks, notice, type CheckResult, type Plan, type Verdict } from "@fieldwork/core";
import { shared, provenance, SYSTEM_BASE, dataBlock, type Ctx } from "./context.js";
import type { Bridged } from "./bridge.js";
import type { Joined } from "./joiner.js";
import type { Wired } from "./wirer.js";

export interface Evaluation {
  verdict: Verdict;
  checks: CheckResult[];
}

// Code checks first; the model then judges whether the result answers the question, and can send work back.
export async function evaluate(ctx: Ctx, question: string, p: Plan, wired: Wired[], bridged: Bridged[], joined: Joined, round: number): Promise<Evaluation> {
  const b = bridged.reduce(
    (acc, x) => ({ matched: acc.matched + x.matched, total: acc.total + x.total, unmatched: acc.unmatched + x.unmatched, invalid: acc.invalid + x.invalid }),
    { matched: 0, total: 0, unmatched: 0, invalid: 0 },
  );
  const checks = runChecks({
    bridge: bridged.length ? b : undefined,
    sourceCounts: wired.map((w) => ({ label: w.label, source: w.sourceCount, zetaris: w.zetarisCount, capped: w.capped })),
    resultRows: joined.result.rows.length,
    duplicatesRemoved: bridged.reduce((n,b)=>n+b.duplicates,0),
    minGroupSize: p.analysis?.basis === "rates" ? minimumDenominator(joined) : undefined,
    result: joined.result,
    years: p.years,
    today: ctx.today,
    excludedTestRecords: wired.reduce((n, w) => n + w.excludedTestRecords, 0),
  });
  checks.push(...analysisChecks(p, joined.sql, joined.result));
  for (const c of checks) await ctx.trace.log({ agent: "evaluator", action: `check:${c.id}`, status: c.ok ? "ok" : "error", note: c.detail });

  for (const [id, code] of [["bridge_match", "JOIN_WEAK"], ["sample_size", "SMALL_SAMPLE"]] as const) {
    const c = checks.find((c) => c.id === id && !c.ok);
    if (c) await ctx.trace.log({ agent: "evaluator", action: code, status: "info", note: notice(code, c.detail).message });
  }
  const failed = checks.filter((c) => !c.ok);
  const rowsPreview = [joined.result.headers, ...joined.result.rows.slice(0, 12)]; // enough to judge; fewer tokens keeps the Evaluator fast
  const { value } = await ctx.models.evaluator.json(
    [
      {
        role: "system",
        content: `${SYSTEM_BASE}
You are the Evaluator. Challenge the work before anyone sees it. Decide APPROVE or REVISE.
Filters listed under sources_as_wired are already applied before the SQL runs; do not ask for them again.
REVISE (with one concrete instruction) when: the result does not answer the question asked; a needed column is missing; the comparison is unfair (e.g. raw counts where tracts differ a lot in population and the question implies a rate); the time filter does not match the plan; or a code check failed and the SQL can fix it.
target "join" = the SQL must change; "wire" = a dataset filter or field must change; "plan" = the wrong data was chosen.
Check the plan analysis: state whether counts or rates answer the question and why in reasons. Relationships must compare population-adjusted city rates with health prevalence, not estimated adult counts. Check denominator labels against SQL (totalpopulation means residents; totalpop18plus means adults), full paired-set size before display limits, and ORDER BY the requested ranking measure. A repeated correlation value is one statistic, not independent confirmation in every row. Check missing values and zero counts separately.
Be brief: judge, do not re-derive the whole analysis. This is round ${round} of at most 3; on round 3 approve unless the answer would be wrong, and list the limits instead.
Shape: {"verdict": "APPROVE" | "REVISE", "target": "join" | "wire" | "plan" | null, "instruction": "..." | null, "reasons": ["short reasons"]}`,
      },
      {
        role: "user",
        content:
          shared(ctx) + `Question: ${question}\n` +
          dataBlock("plan", p) +
          "\n" +
          dataBlock(
            "sources_as_wired",
            [
              `fw_pg.tracts: all ${ctx.cfg.place.countyName} County, ${ctx.cfg.place.stateAbbr} census tracts (state ${ctx.cfg.place.stateFips}, county ${ctx.cfg.place.countyFips}); already county-scoped`,
              ...wired.map((w) => `${w.label} = "${w.title}": filtered AT THE SOURCE with ${w.where}; ${w.zetarisCount} records${(w.shape === "arcgis_features" || w.shape === "epa_facilities") ? "; counted per tract into fw_pg.tract_counts (run_id/source columns only identify this run's counts)" : ""}`),
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
    8000,
  );
  // An empty measure is never a valid answer, whatever the model thinks: the join goes back with the reason.
  const empty = checks.find((c) => ["measure_values", "analysis_basis", "relationship_rates", "ranking_order"].includes(c.id) && !c.ok);
  if (empty && value.verdict === "APPROVE") {
    value.verdict = "REVISE";
    value.target = empty.id === "analysis_basis" ? "plan" : "join";
    value.instruction = `${empty.detail}. Check the join keys and filter values against the table descriptions (for tract_counts, grp = 'all' is the total per tract).`;
    value.reasons = [empty.detail, ...value.reasons].slice(0, 6);
  }
  if(ctx.world) {
    const source=provenance(ctx,"evaluator");
    await ctx.world.upsertContext({type:"round",externalKey:{system:ctx.runId,id:String(round)},attrs:{verdict:value.verdict,checks},source});
    const f=ctx.world.entities().find((e)=>e.type==="finding"&&e.id.endsWith(":query"));
    const decision=await ctx.world.upsertEntity({type:value.verdict==="REVISE" ? "challenge":"finding",externalKey:{system:ctx.runId,id:value.verdict==="REVISE" ? String(round):`approval-${round}`},attrs:{round,status:value.verdict==="REVISE" ? "open":"approved",instruction:value.instruction,reasons:value.reasons},source});
    if(f) await ctx.world.relate({from:decision.id,type:value.verdict==="REVISE" ? "contradicts":"supports",to:f.id,source});
  }
  await ctx.trace.log({
    agent: "evaluator",
    action: "verdict",
    status: value.verdict === "APPROVE" ? "ok" : "info",
    note: value.verdict === "APPROVE" ? `Approved: ${value.reasons.join("; ")}` : `Sent back to the ${value.target ?? "join"}: ${value.instruction ?? value.reasons.join("; ")}`,
  });
  return { verdict: value, checks };
}

function minimumDenominator(joined: Joined): number | undefined {
  const j=joined.result.headers.findIndex((h)=>/^(population|totalpopulation|totalpop18plus|denominator|sample_size)$/i.test(h));
  const values=j<0 ? []:joined.result.rows.map((r)=>r[j]==null ? NaN:Number(r[j])).filter(Number.isFinite);
  return values.length ? Math.min(...values):undefined;
}
