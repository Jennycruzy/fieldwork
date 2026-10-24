import { notice, type RunEvent } from "@fieldwork/core";
import type { CallRecord } from "@fieldwork/llm";
import { writeEvent, type Db } from "./db.js";

// Every step of a run, written to Postgres and echoed to whoever is watching (CLI now, the Desk's live view later).
export class Trace {
  private seq = 0;
  private listeners: ((e: RunEvent) => void)[] = [];

  constructor(
    private readonly db: Db,
    readonly runId: string,
  ) {}

  onEvent(fn: (e: RunEvent) => void): void {
    this.listeners.push(fn);
  }

  async log(e: Omit<RunEvent, "runId" | "seq" | "ts">): Promise<void> {
    const full: RunEvent = { ...e, runId: this.runId, seq: ++this.seq, ts: new Date().toISOString(), note: redact(e.note), sql: e.sql ? redact(e.sql) : undefined };
    await writeEvent(this.db, full);
    for (const fn of this.listeners) fn(full);
  }

  // Hook for the model chain: one event per model call, with the model that actually answered.
  modelCall(agent: string) {
    let failed: {provider:string;model:string} | undefined;
    return async (r: CallRecord) => {
      if (r.ok && failed) {
        const switched=failed.provider!==r.provider || failed.model!==r.modelRequested;
        await this.log({agent,action:switched ? "MODEL_DOWN":"provider_retry",status:"info",note:switched ? notice("MODEL_DOWN",r.modelServed).message : "The retried model request answered."});
        failed=undefined;
      }
      if (!r.ok) failed = {provider:r.provider,model:r.modelRequested};
      await this.log({
        agent,
        action: "model_call",
        status: r.ok ? "ok" : "error",
        note: r.ok ? `answered by ${r.modelServed}` : `attempt ${r.attempt} failed: ${r.error ?? "error"}`,
        modelProvider: r.provider,
        modelRequested: r.modelRequested,
        modelServed: r.ok ? r.modelServed : undefined,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        latencyMs: r.ms,
      });
    };
  }
}

// Secrets never reach the trace, even if a source echoes one back.
export function redact(s: string): string {
  return s
    .replace(/sk-or-[A-Za-z0-9-_]{10,}/g, "[key]")
    .replace(/nvapi-[A-Za-z0-9-_]{10,}/g, "[key]")
    .replace(/(password\s*["':=]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1[hidden]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/g, "$1[token]");
}
