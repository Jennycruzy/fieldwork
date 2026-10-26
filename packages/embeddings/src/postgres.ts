import { validVector, type VectorCache, type CacheKey } from "./index.js";
export interface QueryDb {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export class PostgresVectorCache implements VectorCache {
  private ready?: Promise<unknown>;
  constructor(
    private db: QueryDb,
    private table = "finder_embeddings",
  ) {
    if (!/^(?:pg_temp\.)?[a-z][a-z0-9_]*$/.test(table)) throw new Error("Invalid embedding cache table");
  }
  private async schema() {
    this.ready ??= this.db
      .query(
        "CREATE TABLE IF NOT EXISTS " +
          this.table +
          " (dataset_id text NOT NULL, metadata_hash text NOT NULL, model text NOT NULL, vector jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(dataset_id,metadata_hash,model))",
      )
      .catch((e) => {
        this.ready = undefined;
        throw e;
      });
    await this.ready;
  }
  async get(key: CacheKey) {
    await this.schema();
    const r = await this.db.query(
      "SELECT vector FROM " + this.table + " WHERE dataset_id=$1 AND metadata_hash=$2 AND model=$3",
      [key.datasetId, key.metadataHash, key.model],
    );
    const v = r.rows[0]?.vector;
    return validVector(v) ? v : undefined;
  }
  async put(key: CacheKey, vector: number[]) {
    if (!validVector(vector)) throw new Error("Refused invalid embedding cache vector");
    await this.schema();
    await this.db.query(
      "INSERT INTO " +
        this.table +
        " (dataset_id,metadata_hash,model,vector) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT(dataset_id,metadata_hash,model) DO UPDATE SET vector=EXCLUDED.vector, updated_at=now()",
      [key.datasetId, key.metadataHash, key.model, JSON.stringify(vector)],
    );
  }
}
