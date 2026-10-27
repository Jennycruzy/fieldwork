// Nemotron with one source: each answerable question asked with up to 200 records from the largest dataset
// Fieldwork used for it, as the source publishes them, with no agents, no tract placement and no join.
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
  throw new Error(
    "Usage: tsx scripts/baseline-one-source.ts --ceiling <absolute daily call count to stop at>",
  );

const db = openDb(cfg.pgUrl);
const daily = dbBudget(db, cfg.dailyCalls);
const budget = { take: async () => ((await daily.used()) >= ceiling ? false : daily.take()) };
const cloud = new OpenRouterProvider(cfg.openrouterKey, { allowPaid: false });
const models = ["nvidia/nemotron-3.5-super-vl:free", "nvidia/nemotron-3.5-lightning:free"];
const chain = new ModelChain(
  models.map((model) => ({ provider: cloud, model })),
  { budget },
);
const SAMPLE = 200;

const questions = (
  JSON.parse(readFileSync("evidence/questions.json", "utf8")).questions as {
    id: string;
    question: string;
    expected: string;
  }[]
).filter((q) => q.expected !== "refused-correctly");

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

type Source = { url: string; title: string; filter?: string; records?: number };
// The source's own records, as published: CDC as JSON rows, the city's ArcGIS layers as attributes plus a point.
async function fetchRecords(s: Source): Promise<Record<string, unknown>[]> {
  if (s.url.includes("data.cdc.gov")) {
    const u = new URL(s.url);
    if (s.filter) u.searchParams.set("$where", s.filter);
    u.searchParams.set("$limit", String(SAMPLE));
    return (await (await fetch(u)).json()) as Record<string, unknown>[];
  }
  const u = new URL(s.url.replace(/\/$/, "") + "/query");
  u.searchParams.set("where", s.filter || "1=1");
  u.searchParams.set("outFields", "*");
  u.searchParams.set("outSR", "4326");
  u.searchParams.set("resultRecordCount", String(SAMPLE));
  u.searchParams.set("f", "json");
  const j = (await (await fetch(u)).json()) as {
    features?: { attributes: Record<string, unknown>; geometry?: { x?: number; y?: number } }[];
  };
  return (j.features ?? []).map((f) => ({
    ...f.attributes,
    ...(f.geometry?.x != null ? { longitude: f.geometry.x, latitude: f.geometry.y } : {}),
  }));
}

const Reply = z.object({
  answer: z.string(),
  tracts: z.array(z.object({ tract: z.string(), value: z.number().nullable().optional() })).default([]),
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
  const sources: Source[] = answer?.sources ?? [];
  const source = [...sources].sort((a, b) => (b.records ?? 0) - (a.records ?? 0))[0];
  const nameCol = headers.findIndex((h) => /tract_name|^name$|tract$/i.test(h));
  const byTract = new Map(rows.map((r) => [tractNo(String(r[nameCol >= 0 ? nameCol : 0] ?? "")), r]));
  let records: Record<string, unknown>[] = [],
    reply: z.infer<typeof Reply> | undefined,
    error: string | undefined;
  const start = Date.now();
  try {
    if (!source) throw new Error("no passing run to take a source from");
    records = await fetchRecords(source);
    reply = (
      await chain.json(
        [
          {
            role: "user",
            content:
              `${q.question}\n\nHere are ${records.length} records from "${source.title}" (${source.records ?? "?"} in all), ` +
              `exactly as the source publishes them:\n${JSON.stringify(records)}\n\n` +
              `Answer from these records. Be specific: name the census tracts and give the numbers. ` +
              `If you cannot answer, say so and leave "tracts" empty. Reply with JSON only: ` +
              `{"answer": string, "tracts": [{"tract": "Census Tract <number>", "value": number}]}`,
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
    const matches =
      row != null &&
      x.value != null &&
      row.some(
        (c) =>
          Number.isFinite(num(c)) && Math.abs(num(c) - x.value!) <= Math.max(0.05, Math.abs(num(c)) * 0.01),
      );
    return { tract: x.tract, value: x.value ?? null, value_matches_rows: matches };
  });
  const topTruth = rows[0] ? tractNo(String(rows[0][nameCol >= 0 ? nameCol : 0])) : undefined;
  const top_tract_matches = !!topTruth && tractNo(reply?.tracts?.[0]?.tract ?? "") === topTruth;
  results.push({
    question_id: q.id,
    question: q.question,
    source: source
      ? { title: source.title, url: source.url, records_in_source: source.records ?? null }
      : null,
    records_given: records.length,
    sources_fieldwork_joined: sources.length,
    fieldwork: t ? { run_id: t.run, top_tract: topTruth ?? null } : null,
    seconds: (Date.now() - start) / 1000,
    reply: reply ?? null,
    error: error ?? null,
    declined: !!reply && named.length === 0,
    numbers_given: named.filter((x) => x.value != null).length,
    numbers_matching_rows: named.filter((x) => x.value_matches_rows).length,
    top_tract_matches,
    named,
  });
  console.log(q.id, records.length, named.length, top_tract_matches, error ?? "");
  if (error && /budget|cap|allowance/i.test(error)) break;
}
const sum = (k: string) => results.reduce((a, r) => a + Number((r as Record<string, unknown>)[k] ?? 0), 0);
const out = {
  checked_at: new Date().toISOString(),
  mode: `One prompt per question to Nemotron with up to ${SAMPLE} records from the largest source Fieldwork used, as published; no agents, no tract placement, no join; compared with Fieldwork's passing run rows`,
  models,
  questions: results.length,
  top_tract_matches: results.filter((r) => r.top_tract_matches).length,
  declined: results.filter((r) => r.declined).length,
  numbers_given: sum("numbers_given"),
  numbers_matching_rows: sum("numbers_matching_rows"),
  results,
};
writeFileSync("evidence/baseline-one-source.json", JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ ...out, results: undefined }));
await db.end();
