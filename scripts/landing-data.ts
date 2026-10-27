// Writes apps/web/src/landing.json: the real answers, refusals and batch results the landing page shows.
// Usage: npm run landing-data (reads the local API on FW_PORT, default 8795, and evidence/evaluation.json).
import { readFileSync, writeFileSync } from "node:fs";

const api = `http://127.0.0.1:${process.env.FW_PORT ?? 8795}/api/runs/`;
const MAP_RUN = "r_20261027_8432d7"; // code violations per 1,000 residents, live-verified 27 Oct
const EXAMPLE_RUNS = ["r_20261027_d432a4", "r_20261027_1e00fb", "r_20261027_7a26a0"];
const DECLINED = [
  { run: "r_20261027_704f06", why: "Predictions aren't in public records." },
  { run: "r_20261027_ba432b", why: "It never names people or shows private health details." },
  { run: "r_20261027_f40c30", why: "It doesn't give medical advice." },
];
const STOPPED = "r_20261027_3daa67";

type Run = { run: any; events: { agent: string; action: string; note: string }[] };
const get = async (id: string): Promise<Run> => {
  const r = await fetch(api + id);
  if (!r.ok) throw new Error(`${id}: HTTP ${r.status}`);
  return (await r.json()) as Run;
};
const num = (v: unknown) => Number(v);

const map = await get(MAP_RUN);
const a = map.run.answer;
const col = (name: string) => a.headers.indexOf(name);
const [rate, count, pop, geoid, name] = [
  col("code_violations_count_per_1000_totalpopulation"),
  col("code_violations_count"),
  col("totalpopulation"),
  col("geoid"),
  col("tract_name"),
];
const rows = a.rows.map((r: (string | null)[]) => ({
  geoid: r[geoid]!,
  name: r[name]!,
  rate: Math.round(num(r[rate]) * 10) / 10,
  count: num(r[count]),
  residents: num(r[pop]),
}));

const examples = [];
for (const id of EXAMPLE_RUNS) {
  const x = (await get(id)).run;
  examples.push({
    run: id,
    question: x.question,
    headline: x.answer.answer.headline,
    points: x.answer.answer.points,
  });
}
const declined = [];
for (const d of DECLINED)
  declined.push({ run: d.run, question: (await get(d.run)).run.question, why: d.why });
const stop = await get(STOPPED);
const stopNote = stop.events.find((e) => e.agent === "run" && e.action === "error")!.note;

const evaluation = JSON.parse(readFileSync("evidence/evaluation.json", "utf8"));
const latest = evaluation.latest;
const secs = latest.results.map((r: any) => r.elapsed_ms / 1000).sort((x: number, y: number) => x - y);
const median = secs[Math.ceil(secs.length / 2) - 1];

writeFileSync(
  "apps/web/src/landing.json",
  JSON.stringify(
    {
      map: {
        run: MAP_RUN,
        question: map.run.question,
        headline: a.answer.headline,
        measure: "code violations per 1,000 residents",
        created_at: map.run.created_at,
        records: a.sources.reduce((n: number, s: any) => n + (s.records ?? 0), 0),
        sources: a.sources.map((s: any) => ({ title: s.title, records: s.records, url: s.url })),
        rows,
      },
      examples,
      declined,
      stopped: { run: STOPPED, question: stop.run.question, said: stopNote },
      results: {
        passed: latest.passed,
        total: latest.total,
        median_s: Math.round(median),
        at: latest.started_at,
      },
    },
    null,
    2,
  ) + "\n",
);
console.log(`landing.json: ${rows.length} tracts, ${examples.length} examples, ${declined.length} declined`);
