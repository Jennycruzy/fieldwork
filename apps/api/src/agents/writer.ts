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
Keep the order of the result rows when you describe a ranking ("next" means the next row). If a year is still in progress, say "so far". Mention test records excluded or records that could not be placed, if the checks list them.
Shape: {"headline": "one sentence answer", "points": ["2-5 short supporting facts with numbers"], "how_sure": "one sentence: match rates, sample sizes, checks passed, rounds", "caveats": ["plain-language limits"]}`,
      },
      {
        role: "user",
        content:
          `Question: ${question}\n` +
          dataBlock("result", [joined.result.headers, ...joined.result.rows.slice(0, 30)]) +
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
  await ctx.trace.log({ agent: "writer", action: "answer", status: "ok", note: value.headline });
  return value;
}
