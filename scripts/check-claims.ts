// Fails when a number stated in the README (or another file passed as an argument) differs from its evidence.
// Usage: npm run check:claims [-- other.md ...]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const n = (x: number) => x.toLocaleString("en-US");

const latest = json("evidence/evaluation.json").latest;
const governed = json("evidence/governed-capabilities.json");
const recipes = json("evidence/recipes/drafts.json").drafts as { records: number }[];
const scout = json("evidence/scout/metadata-components.json");
const world = json("evidence/world-model/conformance.json");
const markovian = json("evidence/markovian/conformance.json");
const portability = json("evidence/portability/summary.json");
const answered = (portability.runs as { status: string; seconds: number; model_calls: number }[]).find(
  (r) => r.status === "answered",
)!;
const scoutReport = readFileSync("packages/scout/evals/reports/latest.md", "utf8");
const hmem = execFileSync("npm", ["run", "-s", "conformance:hmem"], { encoding: "utf8" }).match(
  /(\d+)\/(\d+) checks passed/,
)!;
const countKeys = governed.data_quality.results.find(
  (r: { rule: string; table: string }) => r.rule === "geoid" && r.table === "tract_count",
);

// Each claim: the sentence pattern as written in the README and the values the evidence gives it.
const claims: { name: string; pattern: RegExp; expected: string[] }[] = [
  {
    name: "latest full batch",
    pattern: /Latest full batch: \*\*(\d+)\/25\*\* \(median ([\d.]+) s, p90 ([\d.]+) s\)/,
    expected: [String(latest.passed), latest.median_seconds.toFixed(1), latest.p90_seconds.toFixed(1)],
  },
  { name: "H-MEM conformance", pattern: /H-MEM conformance (\d+)\/(\d+)/, expected: [hmem[1]!, hmem[2]!] },
  {
    name: "World Model conformance",
    pattern: /World Model conformance (\d+)\/(\d+)/,
    expected: [String(world.passed), String(world.total)],
  },
  {
    name: "Markovian conformance",
    pattern: /Markovian conformance (\d+)\/(\d+)/,
    expected: [String(markovian.passed), String(markovian.passed + markovian.failed)],
  },
  {
    name: "Scout harness",
    pattern: /Scout harness (\d+)\/(\d+) examples/,
    expected: (() => {
      const total = scoutReport.match(/· (\d+) examples/)![1]!;
      return [/Verdict: ✅ PASS/.test(scoutReport) ? total : "failing", total];
    })(),
  },
  {
    name: "Scout metadata set",
    pattern: /(\d+)\/(\d+) poisoned descriptions blocked, (\d+)\/(\d+) real ones/,
    expected: [scout.poison_blocked, scout.poisoned.length, scout.healthy_blocked, scout.healthy.length].map(
      String,
    ),
  },
  {
    name: "Zetaris data quality",
    pattern: /(\d+)\/(\d+) data-quality checks pass; ([\d,]+)\/([\d,]+) tract counts refer to a real tract/,
    expected: [
      String(governed.data_quality.passed),
      String(governed.data_quality.total),
      n(countKeys.valid),
      n(countKeys.total),
    ],
  },
  {
    name: "verified recipes",
    pattern: /(\d+) recipes verified live: ([\d,]+), ([\d,]+) and ([\d,]+) records/,
    expected: [String(recipes.length), ...recipes.map((r) => n(r.records))],
  },
  {
    name: "portability answer",
    pattern: /answered in (\d+) s with (\d+) model calls/,
    expected: [String(Math.round(answered.seconds)), String(answered.model_calls)],
  },
];

const files = ["README.md", ...process.argv.slice(2)];
const problems: string[] = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const claim of claims) {
    const found = [...text.matchAll(new RegExp(claim.pattern, "g"))];
    if (!found.length && file === "README.md") problems.push(`${file}: the ${claim.name} claim is missing`);
    for (const m of found) {
      const stated = m.slice(1);
      if (stated.join("|") !== claim.expected.join("|"))
        problems.push(
          `${file}: ${claim.name} says ${stated.join(", ")}; evidence says ${claim.expected.join(", ")}`,
        );
    }
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`${claims.length} claims match the evidence in ${files.join(", ")}`);
