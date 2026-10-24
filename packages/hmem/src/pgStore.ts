// Postgres store for H-MEM: the engine keeps working in memory; its records and trust ledger are
// loaded from and saved to Fieldwork's Postgres, so memory survives across runs and machines.

import type pg from "pg";
import { HMEM } from "./engine/index.js";
import type { LedgerEntry, MemoryRecord } from "./engine/types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hmem_records (id text PRIMARY KEY, record jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS hmem_ledger (seq bigserial PRIMARY KEY, memory_id text NOT NULL, entry jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS hmem_meta (key text PRIMARY KEY, value text NOT NULL);
`;

export async function loadMemory(db: pg.Pool, opts: { clock?: () => number; actor?: string } = {}): Promise<HMEM> {
  await db.query(SCHEMA);
  const mem = new HMEM({ clock: opts.clock, actor: opts.actor ?? "fieldwork" });
  const recs = await db.query<{ record: MemoryRecord }>("SELECT record FROM hmem_records");
  const seq = await db.query<{ value: string }>("SELECT value FROM hmem_meta WHERE key = 'seq'");
  mem.store.restoreAll(recs.rows.map((r) => r.record), Number(seq.rows[0]?.value ?? recs.rows.length));
  const led = await db.query<{ entry: LedgerEntry }>("SELECT entry FROM hmem_ledger ORDER BY seq");
  mem.ledger.restore(led.rows.map((r) => r.entry));
  return mem;
}

// Saves every record and any ledger entries written since load.
export async function saveMemory(db: pg.Pool, mem: HMEM, ledgerLoaded: number): Promise<{ records: number; newLedger: number }> {
  const { records, seq } = mem.store.snapshotAll();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM hmem_records");
    for (const r of records) await client.query("INSERT INTO hmem_records (id, record) VALUES ($1, $2)", [r.id, JSON.stringify(r)]);
    await client.query("INSERT INTO hmem_meta (key, value) VALUES ('seq', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [String(seq)]);
    const fresh = mem.ledger.all().slice(ledgerLoaded);
    for (const e of fresh) await client.query("INSERT INTO hmem_ledger (memory_id, entry) VALUES ($1, $2)", [e.memoryId, JSON.stringify(e)]);
    await client.query("COMMIT");
    return { records: records.length, newLedger: fresh.length };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
