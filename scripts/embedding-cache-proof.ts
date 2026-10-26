// Postgres temporary-table component; no model call, question, Zetaris or production-table write.
import { writeFileSync, mkdirSync } from "node:fs";
import { config, loadEnvFile } from "../apps/api/src/config.js";
import { openDb } from "../apps/api/src/db.js";
import { PostgresVectorCache } from "../packages/embeddings/src/postgres.js";
import { EMBED_MODELS } from "../packages/embeddings/src/index.js";
loadEnvFile();
const db = openDb(config().pgUrl),
  client = await db.connect();
try {
  await client.query("BEGIN");
  await client.query(
    "CREATE TEMP TABLE finder_embedding_cache_probe (dataset_id text NOT NULL, metadata_hash text NOT NULL, model text NOT NULL, vector jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(dataset_id,metadata_hash,model)) ON COMMIT DROP",
  );
  const cache = new PostgresVectorCache(client, "pg_temp.finder_embedding_cache_probe"),
    key = { datasetId: "public-source", metadataHash: "first", model: EMBED_MODELS[0] };
  const checks: Record<string, boolean> = {};
  checks.miss = (await cache.get(key)) === undefined;
  await cache.put(key, [0.25, 0.75]);
  checks.roundtrip = JSON.stringify(await cache.get(key)) === "[0.25,0.75]";
  await cache.put(key, [0.5, 0.5]);
  checks.upsert = JSON.stringify(await cache.get(key)) === "[0.5,0.5]";
  checks.metadata_isolation = (await cache.get({ ...key, metadataHash: "changed" })) === undefined;
  checks.model_isolation = (await cache.get({ ...key, model: EMBED_MODELS[1] })) === undefined;
  const count = await client.query("SELECT count(*)::int AS n FROM pg_temp.finder_embedding_cache_probe");
  checks.one_row = count.rows[0].n === 1;
  await client.query("ROLLBACK");
  checks.temporary_table_removed =
    (await client.query("SELECT to_regclass('pg_temp.finder_embedding_cache_probe') AS name")).rows[0]
      .name === null;
  if (!Object.values(checks).every(Boolean)) throw new Error("Postgres cache component failed");
  mkdirSync("evidence/embeddings", { recursive: true });
  writeFileSync(
    "evidence/embeddings/postgres-cache-component.json",
    JSON.stringify(
      {
        checked_at: new Date().toISOString(),
        mode: "isolated connection, temporary table, transaction rolled back",
        checks,
        model_calls: 0,
        question_runs: 0,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(checks));
} finally {
  client.release();
  await db.end();
}
