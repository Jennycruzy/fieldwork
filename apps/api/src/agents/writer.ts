import { AnswerSchema, type Answer, type CheckResult, type Plan } from "@fieldwork/core";
import { SYSTEM_BASE, dataBlock, type Ctx } from "./context.js";
import type { Joined } from "./joiner.js";
import type { Wired } from "./wirer.js";

export async function write(ctx: Ctx, question: string, p: Plan, wired: Wired[], joined: Joined, checks: CheckResult[], rounds: number, fix?: string): Promise<Answer> {
  const { value } = await ctx.models.writer.json(
    [
      {
        role: "system",
        content: `${SYSTEM_BASE}
You are the Writer. Write the answer for a local reporter or city analyst in plain US English.
Use only numbers that appear in the result rows. Say "estimated" for CDC figures. Never claim one thing causes another; say "tracts with more X also have more Y" only if the rows show it.
Mention CDC or model-based health estimates only if a listed source is CDC. For relationship comparisons, report the correlation and paired sample size; do not introduce tract rankings or named examples.
Use the supplied primary_measure_ranks exactly if you mention an ordinal rank; omit other rank claims.
The how_sure line is checked too: no claims of certainty, statistical significance, causation or a universal pattern. A correlation is a descriptive association, not proof. Quote the paired_tracts value for correlation sample size, not the preview length. State the plan's choice of counts or rates and correct denominator in the answer. Never treat a repeated correlation column as evidence of consistency. Do not add ranking claims for supporting measures.
Keep the order of the result rows when you describe a ranking ("next" means the next row; equal values share a rank). Caveats must come from the checks listed or from the nature of the sources (e.g. CDC values are model-based estimates from survey data); never invent limits such as sample sizes that no check reported. If a year is still in progress, say "so far". Mention test records excluded or records that could not be placed, if the checks list them.
Shape: {"headline": "one sentence answer", "points": ["2-5 short supporting facts with numbers"], "how_sure": "one sentence: match rates, sample sizes, checks passed, rounds", "caveats": ["plain-language limits"]}`,
      },
      {
        role: "user",
        content:
          `Question: ${question}\n` +
          dataBlock("primary_measure_ranks", p.output === "ranking" ? joined.result.rows.slice(0,12).map((r)=>({name:r[0],measure:joined.result.headers[1],value:r[1],rank:1+joined.result.rows.filter((other)=>other[1]!=null && r[1]!=null && (/lowest|fewest|smallest|ascending/i.test(p.analysis?.rank_measure ?? "") ? Number(other[1])<Number(r[1]) : Number(other[1])>Number(r[1]))).length})) : []) + "\n" + dataBlock("analysis_choice", p.analysis) + "\n" + dataBlock("result", p.analysis?.relationship ? [joined.result.headers.filter(h=>/corr|paired/i.test(h)),joined.result.rows[0]?.filter((_,i)=>/corr|paired/i.test(joined.result.headers[i]!))??[]] : [joined.result.headers, ...joined.result.rows]) +
          "\n" +
          dataBlock("checks", checks.map((c) => `${c.ok ? "PASS" : "FLAG"} ${c.detail}`)) +
          "\n" +
          dataBlock("sources", wired.map((w) => `${w.title} (${w.zetarisCount} records used; filter ${w.where})`)) +
          `\nEvaluator rounds: ${rounds}. Plan years: ${JSON.stringify(p.years)}` +
          (fix ? `\nYour previous draft had these problems; fix them: ${fix}` : ""),
      },
    ],
    AnswerSchema,
    1500,
  );
  // The checks reach the Writer labelled PASS/FLAG; those labels are for it, not for readers.
  value.how_sure = value.how_sure.replace(/^\s*(PASS|FLAG)\s*:?\s*/i, "");
  await ctx.trace.log({ agent: "writer", action: "answer", status: "ok", note: value.headline });
  return value;
}
