// Public catalog metadata only; no questions, model calls, database writes or Zetaris.
import { searchMontgomeryHub, searchSocrata } from "../packages/sources/src/index.js";
import { mkdirSync, writeFileSync } from "node:fs";
const entries = new Map<string, unknown>();
for (const term of [
  "parks",
  "police",
  "fire",
  "shelter",
  "violations",
  "sirens",
  "bus",
  "library",
  "flood",
  "school",
]) {
  for (const c of await searchMontgomeryHub(term, 10))
    if (!entries.has(c.id) && c.description.trim())
      entries.set(c.id, { id: c.id, title: c.title, description: c.description, url: c.url });
  if (entries.size >= 25) break;
}
if (entries.size < 25)
  for (const c of await searchSocrata("PLACES", ["data.cdc.gov"], 50))
    if (!entries.has(c.id) && c.description.trim())
      entries.set(c.id, { id: c.id, title: c.title, description: c.description, url: c.url });
if (entries.size < 25) throw new Error("Fewer than 25 distinct nonempty catalog descriptions");
mkdirSync("packages/scout/test/fixtures", { recursive: true });
writeFileSync(
  "packages/scout/test/fixtures/real-metadata.json",
  JSON.stringify(
    {
      captured_at: new Date().toISOString(),
      mode: "public catalog metadata; first 25 distinct nonempty descriptions",
      entries: [...entries.values()].slice(0, 25),
    },
    null,
    2,
  ) + "\n",
);
console.log("Captured 25 distinct source descriptions");
