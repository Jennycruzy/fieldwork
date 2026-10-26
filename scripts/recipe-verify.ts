// Run a recipe's create script and its select queries against the live Zetaris instance and record the result.
// Usage: npm run recipe:verify -- <source id> --zetaris-version <version>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { config, loadEnvFile } from "../apps/api/src/config.js";
import { renderRecipe, type RecipeSource } from "../packages/recipes/src/index.js";
import { ZetarisClient } from "../packages/zetaris/src/index.js";
loadEnvFile();

const id = process.argv[2],
  at = process.argv.indexOf("--zetaris-version"),
  zetarisVersion = at < 0 ? undefined : process.argv[at + 1];
if (!id || !zetarisVersion)
  throw new Error("Usage: npm run recipe:verify -- <source id> --zetaris-version <version>");
const source = (
  JSON.parse(readFileSync("evidence/recipes/sources.json", "utf8")).sources as RecipeSource[]
).find((s) => s.id === id);
if (!source) throw new Error("Source id is not in the recorded discovered-source evidence");

const recipe = renderRecipe(source);
const statements = recipe.create
  .split("\n")
  .filter((line) => !line.startsWith("--"))
  .join("\n")
  .split(/;\s*(?:\n|$)/)
  .map((s) => s.trim())
  .filter(Boolean);
// The select script keeps its queries commented out; run each one here.
const queries = recipe.select.split("\n").flatMap((line) => line.match(/^-- (SELECT .*);$/)?.slice(1) ?? []);

const z = new ZetarisClient({ ...config().zetaris, timeoutMs: 300_000 });
const run = async (sql: string) => {
  const now = new Date(),
    minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (minute >= 23 * 60 + 54 || minute < 60)
    throw new Error("External verification is paused for the reserved batch window");
  return z.query(sql);
};

// Start clean: remove what an earlier run left, with the removal commands upstream documents for Zetaris 2.4.3.1.
const db = statements
    .join("\n")
    .match(/^CREATE LIGHTNING DATABASE (\w+)/m)![1]!
    .toLowerCase(),
  container = statements.join("\n").match(/^CREATE SCHEMASTORE CONTAINER (\w+)/m)![1]!,
  raws = [...statements.join("\n").matchAll(/^CREATE LIGHTNING REST TABLE (\w+)/gm)].map((m) => m[1]!);
const teardown = [
  `DROP VIEW ${container}.records`,
  ...raws.map((raw) => `DROP LIGHTNING DATABASE TABLE ${db}.${raw}`),
  `DROP LIGHTNING DATABASE ${db}`,
];
const removed: { sql: string; error?: string }[] = [];
for (const sql of teardown)
  try {
    await run(sql);
    removed.push({ sql });
  } catch (e) {
    removed.push({ sql, error: (e as Error).message });
  }

const ranAt = new Date().toISOString(),
  steps: { sql: string; ms: number; rows?: string[][]; skipped?: string; error?: string }[] = [];
let ok = true;
for (const sql of [...statements, ...queries]) {
  const start = Date.now();
  try {
    const r = await run(sql);
    steps.push({ sql, ms: Date.now() - start, ...(sql.startsWith("SELECT") ? { rows: r.rows } : {}) });
  } catch (e) {
    const message = (e as Error).message;
    // Containers have no SQL removal or IF NOT EXISTS form; upstream's runner skips this one error too.
    if (sql.startsWith("CREATE SCHEMASTORE CONTAINER") && /already exists/i.test(message)) {
      steps.push({ sql, ms: Date.now() - start, skipped: message });
      continue;
    }
    steps.push({ sql, ms: Date.now() - start, error: message });
    ok = false;
    break;
  }
}
const records = ok ? Number(steps[statements.length]?.rows?.[0]?.[0]) : undefined;
const engine = ok ? (await run("SELECT version()")).rows[0]?.[0]?.split(" ")[0] : undefined;
ok &&= records === source.count;

const dir = "evidence/recipes/" + source.slug;
mkdirSync(dir, { recursive: true });
writeFileSync(
  dir + "/run-log.json",
  JSON.stringify(
    {
      source_id: source.id,
      ok,
      ran_at: ranAt,
      zetaris_version: zetarisVersion,
      engine_version: engine,
      statements: statements.length,
      records,
      expected_records: source.count,
      removed_first: removed,
      steps,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `${source.slug}: ${ok ? "verified" : "failed"}; ${records ?? "no"} records, expected ${source.count}`,
);
if (!ok) process.exitCode = 1;
