import { VerdictSchema, runChecks, type CheckResult, type Plan, type Verdict } from "@fieldwork/core";
import { SYSTEM_BASE, dataBlock, type Ctx } from "./context.js";
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
    years: p.years,
    today: ctx.today,
    excludedTestRecords: wired.reduce((n, w) => n + w.excludedTestRecords, 0),
  });
  for (const c of checks) await ctx.trace.log({ agent: "evaluator", action: `check:${c.id}`, status: c.ok ? "ok" : "error", note: c.detail });

  const failed = checks.filter((c) => !c.ok);
  const rowsPreview = [joined.result.headers, ...joined.result.rows.slice(0, 25)];
  const { value } = await ctx.models.evaluator.json(
    [
      {
        role: "system",
        content: `${SYSTEM_BASE}
You are the Evaluator. Challenge the work before anyone sees it. Decide APPROVE or REVISE.
Filters listed under sources_as_wired are already applied before the SQL runs; do not ask for them again.
REVISE (with one concrete instruction) when: the result does not answer the question asked; a needed column is missing; the comparison is unfair (e.g. raw counts where tracts differ a lot in population and the question implies a rate); the time filter does not match the plan; or a code check failed and the SQL can fix it.
target "join" = the SQL must change; "wire" = a dataset filter or field must change; "plan" = the wrong data was chosen.
This is round ${round} of at most 3; on round 3 approve unless the answer would be wrong, and list the limits instead.
Shape: {"verdict": "APPROVE" | "REVISE", "target": "join" | "wire" | "plan" | null, "instruction": "..." | null, "reasons": ["short reasons"]}`,
      },
      {
        role: "user",
        content:
          `Question: ${question}\n` +
          dataBlock("plan", p) +
          "\n" +
          dataBlock(
            "sources_as_wired",
            [
              `fw_pg.tracts: all ${ctx.cfg.place.countyName} County, ${ctx.cfg.place.stateAbbr} census tracts (state ${ctx.cfg.place.stateFips}, county ${ctx.cfg.place.countyFips}); already county-scoped`,
              ...wired.map((w) => `${w.label} = "${w.title}": filtered AT THE SOURCE with ${w.where}; ${w.zetarisCount} records${w.shape === "arcgis_features" ? "; counted per tract into fw_pg.tract_counts (run_id/source columns only identify this run's counts)" : ""}`),
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
    4000,
  );
  await ctx.trace.log({
    agent: "evaluator",
    action: "verdict",
    status: value.verdict === "APPROVE" ? "ok" : "info",
    note: value.verdict === "APPROVE" ? `Approved: ${value.reasons.join("; ")}` : `Sent back to the ${value.target ?? "join"}: ${value.instruction ?? value.reasons.join("; ")}`,
  });
  return { verdict: value, checks };
}
