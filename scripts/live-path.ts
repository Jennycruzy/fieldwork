// The judge path in a real browser: open the Desk, click a sample question, follow the live run to its answer page.
// Usage: tsx scripts/live-path.ts <base URL> <out dir> [phone|desktop]

import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://127.0.0.1:8795";
const out = process.argv[3] ?? "shots";
const phone = process.argv[4] === "phone";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: phone ? { width: 360, height: 780 } : { width: 1280, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
if (process.env.FW_TRACE_HTTP) page.on("response", (r) => r.url().includes("/api/") && console.log(`http ${r.status()} ${r.request().method()} ${r.url()}`));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;

await page.goto(base, { waitUntil: "networkidle" });
await page.screenshot({ path: `${out}/1-home.png`, fullPage: true });
await page.locator(".samples button").first().click();
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
await page.waitForURL(/\/a\/r_/, { timeout: 15 * 60_000 });
await page.waitForSelector(".headline, .error", { timeout: 30_000 });
console.log(`${at()} answer page ${page.url()}`);
console.log(`headline: ${await page.locator(".headline").first().textContent().catch(() => "(none)")}`);
await page.screenshot({ path: `${out}/3-answer.png`, fullPage: true });
await browser.close();
console.log(errors.length ? `browser errors: ${errors.join(" | ")}` : "no browser errors");
