// Types and calls for the Fieldwork API (apps/api/src/server.ts).

export interface RunEvent {
  runId: string;
  seq: number;
  ts: string;
  agent: string;
  action: string;
  status: "ok" | "error" | "info";
  note: string;
  modelProvider?: string;
  modelRequested?: string;
  modelServed?: string;
  latencyMs?: number;
  sql?: string;
  zetarisMs?: number;
  rows?: number;
}

export interface Answer {
  headline: string;
  points: string[];
  how_sure: string;
  caveats: string[];
}

export interface Source {
  licence?: string;
  licenceUrl?: string;
  label?: string;
  title: string;
  url: string;
  records: number;
  sourceCount: number;
  filter: string;
}

export interface RunRecord {
  id: string;
  question: string;
  created_at: string;
  finished_at: string | null;
  status: string;
  rounds: number;
  mode: "live" | "recorded";
  answer: {
    removed_sentences?: string[];
    computed_figures?: {
      id: string;
      value: number;
      formula: string;
      rows: number[];
      labels: string[];
      column?: string;
    }[];
    memoryWrites?: { id: string; content: string }[];
    world?: {
      entities: { id: string; type: string; attrs: Record<string, unknown> }[];
      edges: { from: string; to: string; type: string }[];
    };
    intervals?: { source: string; headers: string[]; rows: (string | null)[][] }[];
    tracts?: { geoid: string; rings: number[][][] }[];
    memories?: { id: string; kind: string; content: string; confidence: number }[];
    answer?: Answer;
    sources?: Source[];
    sql?: string;
    view?: string;
    headers?: string[];
    rows?: (string | null)[][];
    checks?: { ok: boolean; detail: string }[];
    message?: string;
  } | null;
}

export interface RunSummary {
  id: string;
  question: string;
  created_at: string;
  status: string;
  rounds: number;
  mode: "live" | "recorded";
  headline: string | null;
}

export interface Health {
  ok: boolean;
  mode: "live" | "sample";
  recorded: number;
}

export interface RuntimeStatus {
  state: "online" | "unauthorized" | "offline";
  baseUrl: string;
  checkedAt?: string;
  reason: string;
  modes: string[];
  model?: string;
  fallback: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly runId?: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  } catch {
    throw new ApiError("Fieldwork's service isn't answering. Recorded runs still work.", "OFFLINE");
  }
  const body = (await res.json().catch(() => ({}))) as { message?: string; code?: string; runId?: string };
  if (!res.ok)
    throw new ApiError(
      body.message ?? `Request failed (${res.status})`,
      body.code ?? String(res.status),
      body.runId,
    );
  return body as T;
}

export const api = {
  health: () => call<Health>("/api/health"),
  runtime: () => call<RuntimeStatus>("/api/runtime"),
  runs: () => call<{ runs: RunSummary[]; active?: string }>("/api/runs"),
  run: (id: string) => call<{ run: RunRecord; events: RunEvent[] }>(`/api/runs/${id}`),
  ask: (question: string) =>
    call<{ runId: string }>("/api/ask", { method: "POST", body: JSON.stringify({ question }) }),
};

export function watch(
  id: string,
  speed: number,
  onStep: (e: RunEvent) => void,
  onEnd: (status: string) => void,
): () => void {
  const es = new EventSource(`/api/runs/${id}/events${speed ? `?speed=${speed}` : ""}`);
  es.addEventListener("step", (m) => onStep(JSON.parse((m as MessageEvent).data) as RunEvent));
  es.addEventListener("end", (m) => {
    onEnd((JSON.parse((m as MessageEvent).data) as { status: string }).status);
    es.close();
  });
  return () => es.close();
}
