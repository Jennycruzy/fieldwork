// Screenshots of the Desk at phone and desktop widths, light and dark, plus any browser console errors.
// Usage: tsx scripts/desk-shots.ts [base URL] [out dir]   (default http://127.0.0.1:8795, ./shots)

import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://127.0.0.1:8795";
const out = process.argv[3] ?? "shots";
mkdirSync(out, { recursive: true });

const runs = (await (await fetch(`${base}/api/runs`)).json()) as { runs: { id: string; status: string }[] };
const id = runs.runs.find((r) => r.status === "answered")?.id;
const pages = [
  ["landing", "/"],
  ["ask", "/ask"],
  ["answer", `/a/${id}`],
  ["run", `/run/${id}`],
  ["settings", "/settings"],
  ["history", "/history"],
  ["check", "/check"],
  ["how", `/how/${id}`],
  ["missing", "/nope"],
];

const browser = await chromium.launch();
const errors: string[] = [];
for (const [w, h, label] of [
  [360, 780, "phone"],
  [1280, 900, "desktop"],
] as const) {
  for (const scheme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
    const page = await ctx.newPage();
    page.on(
      "console",
      (m) => m.type() === "error" && errors.push(`${label}/${scheme} ${page.url()}: ${m.text()}`),
    );
    page.on("pageerror", (e) => errors.push(`${label}/${scheme} ${page.url()}: ${e.message}`));
    for (const [name, path] of pages) {
      await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(name === "run" ? 4000 : 500);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      if (wide) errors.push(`${label}/${scheme} ${path}: page scrolls sideways`);
      await page.screenshot({ path: `${out}/${name}-${label}-${scheme}.png`, fullPage: true });
    }
    await ctx.close();
  }
}
await browser.close();
console.log(errors.length ? errors.join("\n") : "no console errors, no sideways scroll");

if (errors.length) process.exitCode = 1;
