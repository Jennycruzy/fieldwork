import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { renderRecipe, type RecipeRun, type RecipeSource } from "../packages/recipes/src/index.js";
const id = process.argv[2],
  position = process.argv.indexOf("--repo");
if (!id || position < 0)
  throw new Error("Usage: npm run recipe -- <source id> --repo <local getting-started clone> [--verified]");
const repo = realpathSync(process.argv[position + 1]!);
if (repo === "/root/fieldwork" || repo === process.cwd())
  throw new Error("Use a separate local getting-started clone");
for (const f of ["AGENTS.md", "CONTRIBUTING.md", "open_data/manifest.json"])
  if (!existsSync(join(repo, f))) throw new Error("Missing upstream file " + f);
const source = (
  JSON.parse(readFileSync("evidence/recipes/sources.json", "utf8")).sources as RecipeSource[]
).find((s) => s.id === id);
if (!source) throw new Error("Source id is not in the recorded discovered-source evidence");
// --verified uses the live run recorded by `npm run recipe:verify`.
let run: RecipeRun | undefined;
if (process.argv.includes("--verified")) {
  const log = JSON.parse(readFileSync("evidence/recipes/" + source.slug + "/run-log.json", "utf8"));
  if (!log.ok || log.source_id !== source.id)
    throw new Error("No successful live run is recorded for this source");
  run = log;
}
const generated = renderRecipe(source, run),
  branch = "draft/" + source.slug;
if (
  execFileSync("git", ["status", "--porcelain"], {
    cwd: repo,
    encoding: "utf8",
  }).trim()
)
  throw new Error("The target clone has tracked changes; preserve them first");
const basePosition = process.argv.indexOf("--base");
const base = basePosition < 0 ? "HEAD" : process.argv[basePosition + 1]!;
if (base !== "HEAD" && !/^[a-f0-9]{40}$/.test(base)) throw new Error("Use a commit id for the recipe base");
execFileSync("git", ["switch", "-c", branch, base], { cwd: repo, stdio: "inherit" });
for (const [name, text] of [
  [generated.createPath, generated.create],
  [generated.selectPath, generated.select],
]) {
  const file = resolve(repo, name!);
  if (!file.startsWith(repo + "/")) throw new Error("Unsafe output path");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text!);
}
const manifestPath = join(repo, "open_data/manifest.json"),
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.sources.some((s: { id: string }) => s.id === source.slug))
  throw new Error("This source already has a manifest entry");
manifest.sources.push(generated.manifest);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
const catalog = join(repo, "open_data/rest_apis/rest-api-sources.md");
let c = readFileSync(catalog, "utf8");
const end = c.indexOf('\n\n"Verified"');
if (end < 0) throw new Error("Upstream catalog format changed");
c = c.slice(0, end) + "\n" + generated.catalogRow + c.slice(end) + generated.catalogNote;
writeFileSync(catalog, c);
const howto = join(repo, "open_data/rest_apis/HOWTO.md");
writeFileSync(howto, readFileSync(howto, "utf8") + generated.howto);
execFileSync("python3", ["scripts/onboard.py", "--check"], { cwd: repo, stdio: "inherit" });
execFileSync(
  "python3",
  [
    "-c",
    "import os,re\nbad=[]\nfor root,dirs,files in os.walk('.'):\n dirs[:]=[d for d in dirs if d!='.git']\n for f in files:\n  if not f.endswith('.md'):continue\n  path=os.path.join(root,f)\n  with open(path,encoding='utf-8',errors='ignore') as handle:text=handle.read()\n  for link in re.findall(r'\\]\\(([^)]+)\\)',text):\n   link=link.split('#')[0]\n   if link and not link.startswith(('http://','https://','mailto:')) and not os.path.exists(os.path.normpath(os.path.join(root,link))):bad.append(path+' -> '+link)\nprint('Relative links: '+str(len(bad))+' missing')\nfor item in bad:print(item)\nraise SystemExit(bool(bad))\n",
  ],
  { cwd: repo, stdio: "inherit" },
);
const noteRoot = "/root/fieldwork-private/recipe-drafts";
mkdirSync(noteRoot, { recursive: true });
const text =
  "# Add " +
  source.title +
  " recipe\n\nAdds a persistent REST table, immediate caching, a records view, commented verification queries, and the manifest/catalog entries. " +
  (run
    ? "Verified live on " +
      run.ran_at.slice(0, 10) +
      " against Zetaris " +
      run.zetaris_version +
      ": all " +
      run.statements +
      " create statements and both select queries ran, and `COUNT(*)` returned " +
      run.records +
      " rows, matching the source count recorded when the recipe was generated."
    : "The recipe is unverified: it has not been run against a live instance.") +
  "\n\nLicence evidence is recorded in the catalog. No key or dataset rows are included.\n\nValidation: python3 scripts/onboard.py --check. The repo-wide relative-link check also passed.\n";
writeFileSync(join(noteRoot, source.slug + "-PR.md"), text);
console.log(
  JSON.stringify({
    branch,
    files: [generated.createPath, generated.selectPath],
    status: run ? "verified" : "unverified",
    pr_text: join(noteRoot, source.slug + "-PR.md"),
  }),
);
