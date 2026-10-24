import type { RunEvent } from "@fieldwork/core";
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
    return async (r: CallRecord) =>
      this.log({
        agent,
        action: "model_call",
        status: r.ok ? "ok" : "error",
        note: r.ok ? `answered by ${r.modelServed}` : `attempt ${r.attempt} failed: ${r.error ?? "error"}`,
        modelProvider: r.provider,
        modelRequested: r.modelRequested,
        modelServed: r.modelServed,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        latencyMs: r.ms,
      });
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
