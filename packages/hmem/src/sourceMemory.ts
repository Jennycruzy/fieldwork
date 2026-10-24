// Fieldwork's memory of public data sources, kept in H-MEM.
// Every write carries its source (the run) and confidence; every read is recorded by H-MEM's trust ledger.

import type { HMEM } from "./engine/index.js";
import type { FeedbackKind, MemoryRecord } from "./engine/types.js";

export type SourceFactKind = "choice" | "wiring" | "quality" | "join" | "repair";

export interface SourceFact {
  kind: SourceFactKind;
  runId: string;
  content: string;
  confidence: number;
  refs?: string[]; // dataset URLs
  datasetTitle?: string;
}

export interface Recalled {
  id: string;
  content: string;
  relevance: number;
  confidence: number;
  kind?: SourceFactKind;
  source: string;
}

const KIND_TAG = (k: SourceFactKind) => `fw:${k}`;

// MemoryStoreService.add: a long-term factual memory with provenance pointing at the run that learned it.
export function remember(mem: HMEM, f: SourceFact): MemoryRecord {
  return mem.add({
    content: f.content,
    type: "factual",
    layer: "long_term",
    tags: [KIND_TAG(f.kind), "fieldwork", ...(f.datasetTitle ? [`dataset:${slug(f.datasetTitle)}`] : [])],
    confidence: f.confidence,
    source: `fieldwork:run:${f.runId}`,
    provenance: { origin: "plan_completion", learnedAt: mem.clock(), label: `Learned in run ${f.runId}`, refs: f.refs },
  });
}

// MemoryRetrievalService.query, filtered to Fieldwork's own source memories (optionally of one kind).
export function recall(mem: HMEM, query: string, opts: { kinds?: SourceFactKind[]; topN?: number } = {}): Recalled[] {
  const res = mem.query(query, { topN: (opts.topN ?? 4) * 3 });
  return res.memories
    .filter((m) => m.memory.tags.includes("fieldwork") && !m.memory.supersededBy)
    .map((m) => ({
      id: m.memory.id,
      content: m.memory.content,
      relevance: Number(m.relevance.toFixed(3)),
      confidence: Number(m.memory.confidence.toFixed(3)),
      kind: kindOf(m.memory),
      source: m.memory.source,
    }))
    .filter((m) => !opts.kinds || (m.kind && opts.kinds.includes(m.kind)))
    .slice(0, opts.topN ?? 4);
}

// MemoryRetrievalService.feedback: a memory that helped a run gains confidence; one that misled it loses some.
export function feedback(mem: HMEM, ids: string[], kind: FeedbackKind): void {
  for (const id of new Set(ids)) if (mem.store.get(id)) mem.feedback(id, kind);
}

function kindOf(m: MemoryRecord): SourceFactKind | undefined {
  const t = m.tags.find((x) => x.startsWith("fw:"));
  return t ? (t.slice(3) as SourceFactKind) : undefined;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}
