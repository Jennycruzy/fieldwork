// The first-visit path in a real browser: open the Desk, click a sample question, follow the live run to its answer page.
// Usage: tsx scripts/live-path.ts <base URL> <out dir> [phone|desktop]

import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://127.0.0.1:8795";
const out = process.argv[3] ?? "shots";
const phone = process.argv[4] === "phone";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: phone ? { width: 360, height: 780 } : { width: 1280, height: 900 },
});
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
if (process.env.FW_TRACE_HTTP)
  page.on(
    "response",
    (r) => r.url().includes("/api/") && console.log(`http ${r.status()} ${r.request().method()} ${r.url()}`),
  );
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;

await page.goto(base + "/ask", { waitUntil: "networkidle" });
await page.screenshot({ path: `${out}/1-home.png`, fullPage: true });
await page.locator(".desk-try .chip").first().click();
await page.locator("form.composer button[type=submit]").click();
await page.waitForURL(/\/run\/r_\d{8}_[0-9a-f]{6}$/, { timeout: 30_000 });
console.log(`${at()} run view ${page.url()}`);
await page.waitForSelector(".step", { timeout: 30_000 }).catch(async (e) => {
  console.log(`no steps after 30 s; page says: ${(await page.locator("main").innerText()).slice(0, 400)}`);
  await page.screenshot({ path: `${out}/2-run-stuck.png`, fullPage: true });
  throw e;
});
console.log(`${at()} first step shown`);
await page.waitForTimeout(20_000);
await page.screenshot({ path: `${out}/2-run-live.png`, fullPage: true });
await Promise.race([
  page.waitForURL(/\/a\/r_/, { timeout: 15 * 60_000 }),
  page
    .locator(".outcome.bad")
    .waitFor({ timeout: 15 * 60_000 })
    .then(async () => {
      throw new Error(await page.locator(".outcome.bad").innerText());
    }),
]);
await page.waitForSelector(".headline, .error", { timeout: 30_000 });
console.log(`${at()} answer page ${page.url()}`);
console.log(
  `headline: ${await page
    .locator(".headline")
    .first()
    .textContent()
    .catch(() => "(none)")}`,
);
await page.screenshot({ path: `${out}/3-answer.png`, fullPage: true });
if (!(await page.locator(".headline").count())) throw new Error("The run has no supported prose answer");
const answerUrl = page.url();
const runId = answerUrl.split("/").at(-1)!;
await page.locator(".number-link").first().click();
await page.locator("#answer-rows").waitFor();
if (!(await page.locator("details[open] pre").count()))
  throw new Error("Number click did not expose the query");
await page.locator(".leaflet-container").waitFor({ timeout: 15000 });
for (const label of ["Export CSV", "Export chart PNG", "Citations (text)", "Citations (Markdown)"]) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: label, exact: true }).click();
  const download = await pending;
  await download.saveAs(`${out}/${download.suggestedFilename()}`);
}
await page.getByRole("link", { name: "How it worked", exact: true }).click();
await page.getByRole("heading", { name: "Full trace", exact: true }).waitFor();
for (const route of ["/history", "/check", "/evaluation", "/settings"]) {
  await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
  if (!(await page.locator("h1").count())) throw new Error(`No content at ${route}`);
  await page.screenshot({ path: `${out}/${route.slice(1)}.png`, fullPage: true });
  if (route === "/evaluation") {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
        throw new Error("Evaluation page scrolls sideways");
      if ((await page.locator(".evaluation-question").count()) !== 25)
        throw new Error("Evaluation question evidence is incomplete");
      await page.screenshot({ path: out + "/evaluation-" + colorScheme + ".png", fullPage: true });
    }
  }
}
await page.getByRole("button", { name: "Test connection", exact: true }).click();
await page.waitForTimeout(1000);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
if (overflow) throw new Error("Page scrolls sideways");
writeFileSync(
  `${out}/result.json`,
  JSON.stringify(
    { base, phone, runId, answerUrl, errors, overflow, finished_at: new Date().toISOString() },
    null,
    2,
  ),
);
await browser.close();
if (errors.length) throw new Error(errors.join(" | "));
console.log(errors.length ? `browser errors: ${errors.join(" | ")}` : "no browser errors");
