import pg from "pg";
import type { RunEvent } from "@fieldwork/core";
import type { Budget } from "@fieldwork/llm";

export type Db = pg.Pool;

export function openDb(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 4 });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY,
  question text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  rounds int NOT NULL DEFAULT 0,
  mode text NOT NULL DEFAULT 'live',
  answer jsonb
);
CREATE TABLE IF NOT EXISTS events (
  run_id text NOT NULL REFERENCES runs(id),
  seq int NOT NULL,
  ts timestamptz NOT NULL,
  agent text NOT NULL,
  action text NOT NULL,
  status text NOT NULL,
  note text NOT NULL,
  model_provider text, model_requested text, model_served text,
  tokens_in int, tokens_out int, latency_ms int,
  sql text, zetaris_ms int, rows int,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS world_events (
  run_id text NOT NULL REFERENCES runs(id),
  seq int NOT NULL,
  entry jsonb NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS sources (
  id text PRIMARY KEY,
  catalog text NOT NULL,
  title text NOT NULL,
  url text NOT NULL,
  shape text,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_ok timestamptz,
  last_error text
);
CREATE TABLE IF NOT EXISTS tract_observations (
 run_id text NOT NULL, source text NOT NULL, record_id text NOT NULL,
 geoid text, entity_key text NOT NULL, event_date text, year int, month int,
 category text NOT NULL, value double precision, value_kind text NOT NULL,
 PRIMARY KEY (run_id, source, record_id)
);
CREATE TABLE IF NOT EXISTS tract_counts (
  run_id text NOT NULL,
  source text NOT NULL,
  geoid text NOT NULL,
  grp text NOT NULL,
  n int NOT NULL,
  PRIMARY KEY (run_id, source, geoid, grp)
);
CREATE TABLE IF NOT EXISTS model_calls (
  day date PRIMARY KEY,
  n int NOT NULL DEFAULT 0
);
`;

export async function migrate(db: Db): Promise<void> {
  await db.query(SCHEMA);
}

export async function writeEvent(db: Db, e: RunEvent): Promise<void> {
  await db.query(
    `INSERT INTO events (run_id, seq, ts, agent, action, status, note, model_provider, model_requested, model_served,
       tokens_in, tokens_out, latency_ms, sql, zetaris_ms, rows)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      e.runId,
      e.seq,
      e.ts,
      e.agent,
      e.action,
      e.status,
      e.note,
      e.modelProvider ?? null,
      e.modelRequested ?? null,
      e.modelServed ?? null,
      e.tokensIn ?? null,
      e.tokensOut ?? null,
      e.latencyMs ?? null,
      e.sql ?? null,
      e.zetarisMs ?? null,
      e.rows ?? null,
    ],
  );
}

// A daily cap on model calls, shared by every run, so the free tier never runs dry mid-run without warning.
export function dbBudget(db: Db, cap: number): Budget & { used(): Promise<number> } {
  return {
    async take() {
      const r = await db.query<{ n: number }>(
        `INSERT INTO model_calls (day, n) VALUES (current_date, 1)
         ON CONFLICT (day) DO UPDATE SET n = model_calls.n + 1
         WHERE model_calls.n < $1 RETURNING n`,
        [cap],
      );
      return r.rowCount === 1;
    },
    async used() {
      const r = await db.query<{ n: number }>(`SELECT n FROM model_calls WHERE day = current_date`);
      return r.rows[0]?.n ?? 0;
    },
  };
}
