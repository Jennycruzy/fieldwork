// Fails if a tracked file contains words that belong in private planning notes, not in the product.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const banned = [
  /\bspec\b/i,
  /\bmilestone\b/i,
  /\bgate\s*\d/i,
  /\bG\d{1,2}\b/,
  /\bR[0-3]\b/,
  /\bcodex\b/i,
  /\bclaude\b/i,
  /co-authored-by/i,
  /ai-generated/i,
  /\bhandover\b/i,
];
const allow = [
  /^packages\/world\/conformance\//,
  /^package-lock\.json$/,
  /^scripts\/wordscan\.mjs$/,
  /\/fixtures\//,
  /^packages\/hmem\/(engine|conformance)\//,
  /^packages\/hmem\/src\/engine\//,
  /LICENSE-meterless/,
];
const files = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => !allow.some((a) => a.test(f)));
let bad = 0;
for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    // This is a required Zetaris grammar token, rather than product planning text.
    const productLine = line.replace(/(INFER SQLTABLE (?:SOURCES|COLUMNS)) SPEC\b/gi, "$1");
    for (const re of banned)
      if (re.test(productLine)) {
        console.log(`${f}:${i + 1}: ${re}`);
        bad++;
      }
  });
}
if (bad) {
  console.error(`${bad} line(s) with private planning words`);
  process.exit(1);
}
console.log(`word scan clean (${files.length} files)`);
