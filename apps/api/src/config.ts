import { readFileSync, existsSync } from "node:fs";

// Loads KEY=VALUE lines from .env (never committed) without overriding real environment variables.
export function loadEnvFile(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trimStart().startsWith("#")) continue;
    const [, key, raw] = m;
    if (key && process.env[key] === undefined) process.env[key] = raw!.replace(/^["']|["']$/g, "");
  }
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing setting ${name}. Copy .env.example to .env and fill it in.`);
  return v;
}

export interface Config {
  zetaris: { url: string; email: string; password: string };
  pgUrl: string;
  openrouterKey?: string;
  nvidiaKey?: string;
  meterless: { baseUrl: string; token?: string; model: string };
  dailyCalls: number;
  place: { name: string; stateFips: string; countyFips: string; countyName: string; stateAbbr: string; hub: string };
}

export function config(): Config {
  return {
    zetaris: { url: process.env.ZETARIS_URL ?? "http://127.0.0.1:3000", email: need("ZETARIS_EMAIL"), password: need("ZETARIS_PASSWORD") },
    pgUrl: need("FW_PG_URL"),
    openrouterKey: process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTER_KEY || undefined,
    nvidiaKey: process.env.NVIDIA_API_KEY || undefined,
    meterless: {
      baseUrl: process.env.METERLESS_BASE_URL ?? "http://127.0.0.1:8088/v1",
      token: process.env.METERLESS_RUNTIME_TOKEN || undefined,
      model: process.env.METERLESS_MODEL ?? "meterless/auto",
    },
    dailyCalls: Number(process.env.FW_DAILY_CALLS ?? 45),
    // The product's scope: Montgomery, Alabama (city open data hub + Montgomery County census tracts).
    place: {
      name: "Montgomery, AL",
      stateFips: "01",
      countyFips: "101",
      countyName: "Montgomery",
      stateAbbr: "AL",
      hub: "https://opendata.montgomeryal.gov",
    },
  };
}
