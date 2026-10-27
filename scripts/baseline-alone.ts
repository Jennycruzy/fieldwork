// Nemotron alone: the 20 answerable questions asked directly, one prompt each, with no agents, no tools and no data.
// Each named tract and number is compared with the rows of Fieldwork's own passing run of the same question.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { ModelChain, OpenRouterProvider } from "@fieldwork/llm";
import { config, loadEnvFile } from "../apps/api/src/config.js";
import { openDb, dbBudget } from "../apps/api/src/db.js";

loadEnvFile();
const cfg = config();
if (!cfg.openrouterKey || process.env.FW_ALLOW_PAID_MODELS === "1")
  throw new Error("Free OpenRouter routes only");
const ceiling = Number(process.argv[process.argv.indexOf("--ceiling") + 1]);
if (!process.argv.includes("--ceiling") || !(ceiling > 0 && ceiling <= cfg.dailyCalls))
  throw new Error("Usage: tsx scripts/baseline-alone.ts --ceiling <absolute daily call count to stop at>");

const db = openDb(cfg.pgUrl);
const daily = dbBudget(db, cfg.dailyCalls);
const budget = { take: async () => ((await daily.used()) >= ceiling ? false : daily.take()) };
const cloud = new OpenRouterProvider(cfg.openrouterKey, { allowPaid: false });
const models = ["nvidia/nemotron-3.5-super-vl:free", "nvidia/nemotron-3.5-lightning:free"];
const chain = new ModelChain(
  models.map((model) => ({ provider: cloud, model })),
  { budget },
);

const questions = (
  JSON.parse(readFileSync("evidence/questions.json", "utf8")).questions as {
    id: string;
    question: string;
    expected: string;
  }[]
).filter((q) => q.expected !== "refused-correctly");

// The newest full batch in which each question passed supplies its rows.
const batches = readdirSync("evidence/question-set")
  .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
  .sort()
  .reverse()
  .map((f) => JSON.parse(readFileSync("evidence/question-set/" + f, "utf8")))
  .filter((b) => b.complete);
const truth = (id: string) => {
  for (const b of batches) {
    const r = b.results.find(
      (x: { question_id: string; passed: boolean }) => x.question_id === id && x.passed,
    );
    if (r) return { run: r.run_id as string, status: r.status as string };
  }
};

const Reply = z.object({
  answer: z.string(),
  tracts: z.array(z.object({ tract: z.string(), value: z.number().nullable().optional() })).default([]),
  sources: z.array(z.string()).default([]),
});
const tractNo = (s: string) =>
  /(\d+(?:\.\d+)?)/.exec(s.replace(/census|tract/gi, ""))?.[1]?.replace(/\.0+$/, "");
const num = (c: unknown) => (c == null ? NaN : Number(String(c).replace(/[,%]/g, "")));

const results = [];
for (const q of questions) {
  const t = truth(q.id);
  const answer = t && JSON.parse(readFileSync(`evidence/runs/${t.run}.run.json`, "utf8")).answer;
  const headers: string[] = answer?.headers ?? [];
  const rows: (string | null)[][] = answer?.rows ?? [];
  const nameCol = headers.findIndex((h) => /tract_name|^name$|tract$/i.test(h));
  const byTract = new Map(rows.map((r) => [tractNo(String(r[nameCol >= 0 ? nameCol : 0] ?? "")), r]));
  // Tract numbers from the 71 Montgomery GEOIDs: the last six digits are the tract code (000100 -> 1, 005614 -> 56.14).
  const real = new Set(
    (JSON.parse(readFileSync("apps/web/public/tracts/01101.json", "utf8")).tracts as { geoid: string }[]).map(
      (t) => String(Number(t.geoid.slice(-6)) / 100),
    ),
  );
  let reply: z.infer<typeof Reply> | undefined, error: string | undefined;
  const start = Date.now();
  try {
    reply = (
      await chain.json(
        [
          {
            role: "user",
            content:
              `${q.question}\n\nAnswer from your own knowledge. Be specific: name the census tracts and give the numbers. ` +
              `If you cannot answer, say so and leave "tracts" empty. Reply with JSON only: ` +
              `{"answer": string, "tracts": [{"tract": "Census Tract <number>", "value": number}], "sources": [string]}`,
          },
        ],
        Reply,
        1500,
      )
    ).value;
  } catch (e) {
    error = (e as Error).message.slice(0, 300);
  }
  const named = (reply?.tracts ?? []).map((x) => {
    const n = tractNo(x.tract),
      row = n ? byTract.get(n) : undefined;
    const exists = !!n && real.has(String(Number(n)));
    const matches =
      row != null &&
      x.value != null &&
      row.some(
        (c) =>
          Number.isFinite(num(c)) && Math.abs(num(c) - x.value!) <= Math.max(0.05, Math.abs(num(c)) * 0.01),
      );
    return { tract: x.tract, value: x.value ?? null, exists, value_matches_rows: matches };
  });
  const topTruth = rows[0] ? tractNo(String(rows[0][nameCol >= 0 ? nameCol : 0])) : undefined;
  results.push({
    question_id: q.id,
    question: q.question,
    fieldwork: t ? { run_id: t.run, status: t.status, top_tract: topTruth ?? null } : null,
    seconds: (Date.now() - start) / 1000,
    reply: reply ?? null,
    error: error ?? null,
    declined: !!reply && named.length === 0,
    numbers_given: named.filter((x) => x.value != null).length,
    numbers_matching_rows: named.filter((x) => x.value_matches_rows).length,
    tracts_that_do_not_exist: named.filter((x) => !x.exists).length,
    top_tract_matches: !!topTruth && tractNo(reply?.tracts?.[0]?.tract ?? "") === topTruth,
    named,
  });
  console.log(q.id, results.at(-1)!.numbers_given, results.at(-1)!.numbers_matching_rows, error ?? "");
  if (error && /budget|cap|allowance/i.test(error)) break;
}
const sum = (k: string) => results.reduce((a, r) => a + Number((r as Record<string, unknown>)[k] ?? 0), 0);
const out = {
  checked_at: new Date().toISOString(),
  mode: "One prompt per question to Nemotron, no agents, no tools, no data; compared with Fieldwork's passing run rows",
  models,
  questions: results.length,
  answered_with_numbers: results.filter((r) => r.numbers_given > 0).length,
  declined: results.filter((r) => r.declined).length,
  numbers_given: sum("numbers_given"),
  numbers_matching_rows: sum("numbers_matching_rows"),
  tracts_that_do_not_exist: sum("tracts_that_do_not_exist"),
  top_tract_matches: results.filter((r) => r.top_tract_matches).length,
  results,
};
writeFileSync("evidence/baseline-alone.json", JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ ...out, results: undefined }));
await db.end();
