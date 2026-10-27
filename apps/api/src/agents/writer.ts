import { z } from "zod";
import { writerChunks } from "../writerChunks.js";
import { computeFigureLedger, AnswerSchema, type Answer, type CheckResult, type Plan } from "@fieldwork/core";
import { systemBase, dataBlock, type Ctx } from "./context.js";
import type { Joined } from "./joiner.js";
import type { Wired } from "./wirer.js";

export async function write(
  ctx: Ctx,
  question: string,
  p: Plan,
  wired: Wired[],
  joined: Joined,
  checks: CheckResult[],
  rounds: number,
  fix?: string,
): Promise<Answer> {
  const chunked = await writerChunks(ctx, question, p, joined, checks);
  const rankFacts =
    p.output === "ranking"
      ? primaryRankFacts(joined.result.headers, joined.result.rows, p.analysis?.rank_measure ?? "")
      : undefined;
  const callSources = wired.filter((w) => /^Call_Count_By_Origin$/i.test(w.valueField ?? ""));
  const callActivity = callSources.length > 0 || checks.some((c) => c.ok && c.id.startsWith("call_units_"));
  const omittedInternal: string[] = [];
  const { value } = await ctx.models.writer.json(
    [
      {
        role: "system",
        content: `${systemBase(ctx)}
You are the Writer. Write the answer for a local reporter or city analyst in plain US English.
Use exact figures only: never approximate to round thousands (use 44,752, never 45,000). Display counts as integers and rates or percentage changes to at most two decimals. Every number must come from a row cell or computed_figures. Never sum rates or call their sum an average. Never call a partial month or year the lowest/highest, or rank it against full periods. Never use rank words without naming the row, except a supplied tie group with its exact size and rank. Describe thresholds only when the actual checks establish them.
Use only numbers in the rows or in computed_figures. For a total, difference, percent change or group size, copy it from computed_figures; never compute one yourself. The result_summary gives the full cohort size. For rankings the result table contains primary_rank, rank_text and tie_size computed in code for every row. Copy these fields exactly. Use only the supplied tie_groups: adjacent rows or rounded display values do not establish a tie. Say "estimated" for CDC figures. Never claim one thing causes another; say "tracts with more X also have more Y" only if the rows show it.
For current listings give the retrieval date, and state when source publication or event dates are unknown. Keep the survey or estimate year distinct from a CDC release year; if the underlying year is not supplied, say it is not established here. Use source_field_definitions for the underlying vintage: population is Census population, not a model-based health estimate. Never infer its year from plan years, CDC release year, or retrieval date. If field definitions do not establish a vintage, say it is not established here. Identify the CDC PLACES release separately.
Only health measures explicitly described as model-based in source metadata are model-based estimates. Registry facilities, city records and inspection results are counts or observations, never model-based estimates. In mixed-source answers describe each measure separately; never call both variables model-based. For relationship comparisons, report the correlation and paired sample size; do not introduce tract rankings or named examples.
Use the supplied primary_measure_ranks exactly if you mention an ordinal rank; omit other rank claims.
The how_sure line is checked too: no claims of certainty, statistical significance, causation or a universal pattern. A correlation is a descriptive association, not proof. Quote the paired_tracts value for correlation sample size, not the preview length. State the plan's choice of counts or rates and correct denominator in the answer. Never treat a repeated correlation column as evidence of consistency. Do not add ranking claims for supporting measures.
Keep the order of the result rows when you describe a ranking ("next" means the next row; equal values share a rank). Caveats must come from the checks listed or from the nature of the sources (e.g. CDC values are model-based estimates from survey data); never invent limits such as sample sizes that no check reported. If a year is still in progress, say "so far". Mention test records excluded or records that could not be placed, if the checks list them.
Points must describe substantive findings for the reader. Never repeat internal wording such as "all checks passed", "subsample truncation", "measure column", SQL column names, or implementation details. Translate cohort coverage as "The comparison includes all eligible tracts." Do not invent significance thresholds.
Shape: {"headline": "one sentence answer", "points": ["2-5 short supporting facts with numbers"], "how_sure": "one nonempty sentence about source coverage and descriptive limits", "caveats": ["plain-language limits"]}`,
      },
      {
        role: "user",
        content:
          `Question: ${question}\n` +
          dataBlock("result_summary", {
            row_count: joined.result.rows.length,
            rank_rows: rankFacts ? joined.result.rows.length : 0,
            zero_columns: joined.result.headers.filter(
              (_h, j) =>
                j > 0 &&
                joined.result.rows.length > 0 &&
                joined.result.rows.every((r) => r[j] != null && Number(r[j]) === 0),
            ),
          }) +
          "\n" +
          dataBlock("computed_figures", computedFigures(joined.result.headers, joined.result.rows)) +
          "\n" +
          dataBlock(
            "primary_measure_ranks",
            rankFacts
              ? {
                  measure: joined.result.headers[1],
                  direction: rankFacts.direction,
                  tie_groups: rankFacts.tie_groups,
                }
              : [],
          ) +
          "\n" +
          dataBlock("analysis_choice", p.analysis) +
          "\n" +
          dataBlock(
            "result",
            chunked?.facts.length
              ? {
                  checked_chunk_facts: chunked.facts,
                  headers: rankFacts?.headers ?? joined.result.headers,
                  first_rows: (rankFacts?.rows ?? joined.result.rows).slice(0, 5),
                }
              : p.analysis?.relationship
                ? [
                    joined.result.headers.filter((h) => /corr|paired/i.test(h)),
                    joined.result.rows[0]?.filter((_, i) => /corr|paired/i.test(joined.result.headers[i]!)) ??
                      [],
                  ]
                : rankFacts
                  ? [rankFacts.headers, ...rankFacts.rows]
                  : [joined.result.headers, ...joined.result.rows],
          ) +
          "\n" +
          dataBlock(
            "checks",
            checks.map((c) => `${c.ok ? "PASS" : "FLAG"} ${c.detail}`),
          ) +
          "\n" +
          dataBlock(
            "source_units",
            callSources.map((w) => ({
              source: w.title,
              value_field: w.valueField,
              unit: "weighted call-center activity",
              aggregation: "SUM of the published count, not COUNT of source rows",
            })),
          ) +
          "\n" +
          dataBlock(
            "source_field_definitions",
            wired.map((w) => ({
              source: w.title,
              definitions: w.fieldDefinitions ?? {},
              records:
                w.shape === "epa_facilities" || w.normalized
                  ? "registry or city records, not model-based estimates"
                  : undefined,
            })),
          ) +
          "\n" +
          dataBlock(
            "sources",
            wired.map((w) => `${w.title} (${w.zetarisCount} records used; filter ${w.where})`),
          ) +
          `\nEvaluator rounds: ${rounds}. Plan years: ${JSON.stringify(p.years)}` +
          (fix ? `\nYour previous draft had these problems; fix them: ${fix}` : ""),
      },
    ],
    writerSchema(wired, (sentence) => omittedInternal.push(sentence)),
    1500,
  );
  if (omittedInternal.length)
    await ctx.trace.log({
      agent: "writer",
      action: "plain_language",
      status: "info",
      note: JSON.stringify({ omitted_internal_sentences: omittedInternal }),
    });
  for (const w of wired.filter(
    (w) => new URL(w.sourceUrl ?? "https://unknown.invalid").hostname === "data.cdc.gov",
  )) {
    const definitions = Object.entries(w.fieldDefinitions ?? {}).filter(([f]) =>
      /^totalpopulation$|^totalpop18plus$/i.test(f),
    );
    if (w.fields?.some((f) => /^totalpopulation$|^totalpop18plus$/i.test(f))) {
      const caveat = definitions.length
        ? "Population denominators in " +
          w.title +
          ": " +
          [...new Set(definitions.map(([, d]) => d))].join("; ") +
          ". The release year is not the population year."
        : "Population denominators come from " +
          w.title +
          "; their underlying vintage is not established here. The release year is not the population year.";
      if (!value.caveats.includes(caveat)) value.caveats.push(caveat);
    }
  }
  if (callActivity) {
    const caveat =
      "These are weighted call-center activity totals, not confirmed incidents or crime statistics.";
    if (!value.caveats.includes(caveat)) value.caveats.push(caveat);
  }
  if (wired.some((w) => w.shape === "epa_facilities")) {
    const caveat = "Facility registry listings are not measurements of emissions or personal exposure.";
    if (!value.caveats.includes(caveat)) value.caveats.push(caveat);
  }
  if (checks.some((c) => c.id === "sample_size" && !c.ok)) {
    const caveat =
      "Small establishment samples or population denominators are flagged in the checks; comparisons describe the listed records and should be interpreted cautiously.";
    if (!value.caveats.includes(caveat)) value.caveats.push(caveat);
  }
  for (const c of checks.filter((c) => c.ok && c.id === "partial_month"))
    if (!value.caveats.includes(c.detail)) value.caveats.push(c.detail);
  // The checks reach the Writer labelled PASS/FLAG; those labels are for it, not for readers.
  value.how_sure = value.how_sure.replace(/^\s*(PASS|FLAG)\s*:?\s*/i, "");
  await ctx.trace.log({ agent: "writer", action: "answer", status: "ok", note: value.headline });
  return value;
}

export function writerSchema(
  wired: Pick<Wired, "fields" | "fieldDefinitions">[],
  onOmit?: (sentence: string) => void,
) {
  return AnswerSchema.superRefine((a, ctx) => {
    const texts = [a.headline, ...a.points, a.how_sure, ...a.caveats];
    for (const text of texts) {
      for (const part of text.split(/[.;]|\b(?:while|whereas|but)\b/i)) {
        const clause = part.replace(
          /\b(?:not|never)\s+(?:model[- ](?:based|derived)|modelled|modeled)(?:\s+estimates?)?/gi,
          "",
        );
        const model = /model[- ](?:based|derived)|modelled|modeled/i;
        const nonModelled =
          /\b(?:facilit\w*|registry|city records|violations|inspection scores|population)\b/i;
        const predicate =
          /\b(?:is|are|was|were|as)\s+(?:(?:also|both|all|a|an)\s+)*(?:model[- ](?:based|derived)|modelled|modeled)/i.exec(
            clause,
          );
        const subject = predicate
          ? clause
              .slice(0, predicate.index)
              .split(/,|\b(?:compared|versus)\b/i)
              .at(-1)!
          : "";
        const countsAsModifier =
          /(?:model[- ](?:based|derived)|modelled|modeled)\s+(?:(?:estimates?|counts?|rates?|of|for|the)\s+){0,4}(?:facilit\w*|registry|city records|violations|inspection scores|population)\b/i.test(
            clause,
          );
        const hasModelledMeasure = wired.some(
          (w) =>
            w.fields?.some((f) => /_crudeprev$/i.test(f)) ||
            Object.values(w.fieldDefinitions ?? {}).some((d) => /model[- ]based/i.test(d)),
        );
        if (
          model.test(clause) &&
          (!hasModelledMeasure ||
            /\bboth (?:variables|measures)|\ball (?:variables|measures|data)\b/i.test(clause) ||
            countsAsModifier ||
            nonModelled.test(subject))
        )
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "This clause labels an unmodelled measure as model-based: " +
              JSON.stringify(clause.trim()) +
              ". Only the health estimate is model-based; registry and city records are counts, and population follows its published Census vintage. Write separate sentences for the source types.",
          });
      }
      const population = wired.filter((w) =>
        w.fields?.some((f) => /^totalpopulation$|^totalpop18plus$/i.test(f)),
      );
      const years = population.flatMap((w) =>
        Object.entries(w.fieldDefinitions ?? {})
          .filter(([f]) => /^totalpopulation$|^totalpop18plus$/i.test(f))
          .flatMap(([, d]) => d.match(/\b(?:19|20)\d{2}\b/g) ?? []),
      );
      const claimed =
        text.match(
          /\b(?:19|20)\d{2}(?=\s+(?:census[- ]tract\s+)?population)|(?<=from the )\b(?:19|20)\d{2}(?=\s+datasets)/gi,
        ) ?? [];
      if (/population/i.test(text) && years.length && claimed.some((y) => !years.includes(y)))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Population vintage must match the source field definitions: " + years.join(", "),
        });
    }
  }).transform((answer) => ({
    ...answer,
    points: answer.points
      .map((point) =>
        point
          .split(/(?<=[.!?])\s+(?=[A-Z])/)
          .filter((sentence) => {
            if (!/all checks passed|subsample|truncation|measure column|paired_tracts/i.test(sentence))
              return true;
            onOmit?.(sentence);
            return false;
          })
          .join(" "),
      )
      .filter(Boolean),
  }));
}

export function primaryRankFacts(headers: string[], rows: (string | null)[][], rankMeasure: string) {
  const ascending = /lowest|fewest|smallest|ascending/i.test(rankMeasure);
  const numbers = rows.map((r) =>
    r[1] != null && r[1] !== "" && Number.isFinite(Number(r[1])) ? Number(r[1]) : null,
  );
  const ordinal = (n: number) =>
    `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th")}`;
  const groups = new Map<
    number,
    { rank: number; value: string; tie_size: number; names: (string | null)[] }
  >();
  const ranked = rows.map((row, i) => {
    const n = numbers[i];
    if (n == null) return [...row, null, null, null];
    const rank = 1 + numbers.filter((v) => v != null && (ascending ? v < n : v > n)).length;
    const names = rows.filter((_, j) => numbers[j] === n).map((r) => r[0] ?? null);
    if (names.length > 1) groups.set(n, { rank, value: row[1]!, tie_size: names.length, names });
    return [...row, String(rank), ordinal(rank), String(names.length)];
  });
  return {
    direction: ascending ? "ascending" : "descending",
    headers: [...headers, "primary_rank", "rank_text", "tie_size"],
    rows: ranked,
    tie_groups: [...groups.values()],
  };
}

// Totals, extremes, differences, percent changes and group sizes for the first measure column, computed in code
// so the Writer copies them instead of doing arithmetic ("sums to 16,388" for 16,409 is the slip this prevents).
export function computedFigures(headers: string[], rows: (string | null)[][]) {
  const calendar = headers[0] === "year" && headers[1] === "month";
  const nameCol = calendar
    ? -1
    : Math.max(
        0,
        headers.findIndex((h) => /^(?:name|tract_name|tract|category|area_name)$/i.test(h)),
      );
  const label = (r: (string | null)[]) =>
    calendar
      ? `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][Number(r[1]) - 1]} ${r[0]}`
      : String(r[nameCol] ?? "");
  const j = headers.findIndex(
    (h, k) =>
      k !== nameCol &&
      !/^(?:year|month|geoid|tractfips|name)$/i.test(h) &&
      rows.some((r) => r[k] != null && Number.isFinite(Number(r[k]))),
  );
  if (j < 0 || !rows.length) return {};
  const cells = rows
    .map((r) => ({ row: r, v: r[j] == null ? NaN : Number(r[j]) }))
    .filter((x) => Number.isFinite(x.v));
  if (!cells.length) return {};
  const round = (x: number, d = 2) => Number(x.toFixed(d));
  const pct = (a: number, b: number) => (a === 0 ? null : round(((b - a) / a) * 100, 1));
  const max = cells.reduce((a, b) => (b.v > a.v ? b : a)),
    min = cells.reduce((a, b) => (b.v < a.v ? b : a)),
    first = cells[0]!,
    last = cells[cells.length - 1]!;
  const counts = new Map<number, number>();
  for (const c of cells) counts.set(c.v, (counts.get(c.v) ?? 0) + 1);
  return {
    ledger: computeFigureLedger(headers, rows)
      .filter(
        (f) =>
          calendar ||
          !["difference", "percent_change"].includes(f.kind) ||
          f.rows.every((i) => i < 5) ||
          f.rows.every((i) => i === rows.indexOf(min.row) || i === rows.indexOf(max.row)),
      )
      .map(({ labels, ...f }) => f),
    measure: headers[j],
    ...(!/rate|per_|prevalence|percent|pct|corr|score|avg|average|mean/i.test(headers[j]!)
      ? { total: round(cells.reduce((a, b) => a + b.v, 0)) }
      : {}),
    rows_with_values: cells.length,
    highest: { row: label(max.row), value: max.v },
    lowest: { row: label(min.row), value: min.v },
    highest_minus_lowest: round(max.v - min.v),
    highest_vs_lowest_percent: pct(min.v, max.v),
    ...(calendar
      ? {
          first: { row: label(first.row), value: first.v },
          last: { row: label(last.row), value: last.v },
          last_minus_first: round(last.v - first.v),
          last_vs_first_percent: pct(first.v, last.v),
        }
      : {}),
    rows_at_zero: cells.filter((c) => c.v === 0).length,
    rows_above_zero: cells.filter((c) => c.v > 0).length,
    ...(counts.size <= 12 ? { rows_per_value: [...counts].map(([value, rows]) => ({ value, rows })) } : {}),
  };
}
