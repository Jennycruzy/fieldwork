import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
const local = "packages/scout/evals",
  upstream = process.env.SCOUT_UPSTREAM;
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
// A digest binds the unchanged harness and locked inputs. Reports are deliberately excluded.
const inputs = files(local)
  .filter((f) => !f.includes("/reports/"))
  .sort();
const h = createHash("sha256");
for (const f of inputs) {
  const rel = relative(local, f),
    body = readFileSync(f);
  h.update(rel).update(body);
  if (upstream && !body.equals(readFileSync(join(upstream, rel))))
    throw new Error("Upstream input differs: " + rel);
}
const digest = h.digest("hex");
if (digest !== "0748e29803b8f6d9cbbb3cddcb5335f8d6e57d54d7afa085039087555e1ccc3f")
  throw new Error("Locked Scout inputs changed");
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "packages/scout/evals/runner/index.ts", "all"],
  {
    encoding: "utf8",
    env: { ...process.env, SCOUT_IMPL: join(process.cwd(), "packages/scout/src/index.ts") },
  },
);
const output = result.stdout + result.stderr;
process.stdout.write(output);
if (result.status !== 0 || /\bSkipped\b/.test(output) || !output.includes("Loaded 32 examples"))
  process.exit(1);
console.log("Unchanged Scout harness completed all 32 examples; inputs sha256 " + digest);
