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
  answerLineage?: boolean;
  markovianWriter?: boolean;
  scoutGuard?: boolean;
  finderEmbeddings?: boolean;
  freshMemory?: boolean;
  place: Place;
}

export interface Place {
  name: string;
  city: string;
  region: string;
  stateFips: string;
  countyFips: string;
  countyName: string;
  stateAbbr: string;
  hub: string;
  tractsTable?: string;
}

const MONTGOMERY: Place = {
  name: "Montgomery, AL",
  city: "Montgomery",
  region: "Montgomery, Alabama",
  stateFips: "01",
  countyFips: "101",
  countyName: "Montgomery",
  stateAbbr: "AL",
  hub: "https://opendata.montgomeryal.gov",
};

// FW_PLACE names a JSON file describing another place, for portability runs only. The product serves Montgomery.
function place(): Place {
  const file = process.env.FW_PLACE;
  if (!file) return MONTGOMERY;
  const p = JSON.parse(readFileSync(file, "utf8")) as Place;
  const text = [p.name, p.city, p.region, p.countyName, p.stateAbbr];
  if (
    text.some((t) => typeof t !== "string" || !/^[A-Za-z .,'-]{2,60}$/.test(t)) ||
    !/^\d{2}$/.test(p.stateFips) ||
    !/^\d{3}$/.test(p.countyFips) ||
    !/^https:\/\/[a-z0-9.-]+$/.test(p.hub) ||
    (p.tractsTable !== undefined && !/^tracts_\d{5}$/.test(p.tractsTable))
  )
    throw new Error("FW_PLACE does not describe a valid place");
  return p;
}

export function config(): Config {
  return {
    zetaris: {
      url: process.env.ZETARIS_URL ?? "http://127.0.0.1:3000",
      email: need("ZETARIS_EMAIL"),
      password: need("ZETARIS_PASSWORD"),
    },
    pgUrl: need("FW_PG_URL"),
    openrouterKey: process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTER_KEY || undefined,
    nvidiaKey: process.env.NVIDIA_API_KEY || undefined,
    meterless: {
      baseUrl: process.env.METERLESS_BASE_URL ?? "http://127.0.0.1:8088/v1",
      token: process.env.METERLESS_RUNTIME_TOKEN || undefined,
      model: process.env.METERLESS_MODEL ?? "meterless/auto",
    },
    dailyCalls: Number(process.env.FW_DAILY_CALLS ?? 45),
    answerLineage: process.env.FW_ANSWER_LINEAGE === "1",
    finderEmbeddings: process.env.FW_FINDER_EMBEDDINGS === "1",
    scoutGuard: process.env.FW_SCOUT_GUARD === "1",
    markovianWriter: process.env.FW_MARKOVIAN_WRITER === "1",
    freshMemory: process.env.FW_FRESH_MEMORY === "1",
    // The product's scope: Montgomery, Alabama (city open data hub + Montgomery County census tracts).
    place: place(),
  };
}
