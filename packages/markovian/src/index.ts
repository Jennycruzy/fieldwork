import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export interface ChunkConfig {
  chunkSize: number;
  maxChunks: number;
  carryoverTokens: number;
  overlapTokens: number;
}
export interface ChunkInfo {
  id: number;
  tokens: number;
  carryover: string;
  content: string;
  nextCarryover?: string;
  cascadeLevelUsed?: number;
  tokenLabel?: "measured" | "estimated";
}
export interface MarkovianRun {
  id: string;
  timestamp: number;
  prompt: string;
  mode: "ARCHITECT" | "RESEARCH";
  chunkConfig: ChunkConfig;
  chunks: ChunkInfo[];
  status: "completed" | "max-chunks" | "errored" | "aborted";
  output: string;
  tokenLabel: "measured" | "estimated";
  efficiencyLabel: "modeled";
  totalTokensUsed: number;
  totalTokensSaved: number;
  efficiencyPercent: number;
  durationMs: number;
  reflection?: string;
  reflectionError?: string;
  error?: string;
}
export type Generator = (
  prompt: string,
  attachments: { name: string; content: string }[],
  systemPrompt?: string,
  onStream?: (delta: string) => void,
  signal?: AbortSignal,
) => Promise<{ text: string; metadata?: unknown }>;
export interface RunOptions {
  prompt?: string;
  goal?: string;
  mode?: "ARCHITECT" | "RESEARCH";
  generator?: Generator;
  memoryContext?: string;
  attachments?: { name: string; content: string }[];
  abortSignal?: AbortSignal;
  onStream?: (text: string) => void;
  reflect?: boolean;
  stopWhen?: (x: { step: number; carryover: string }) => boolean;
  onChunk?: (chunk: ChunkInfo) => void | Promise<void>;
  stepFn?: (x: {
    goal: string;
    carryover: string;
    step: number;
    prompt: string;
  }) => { content: string } | Promise<{ content: string }>;
}
export interface EngineOptions {
  chunkConfig?: Partial<ChunkConfig>;
  clock?: () => number;
  generator?: Generator;
  compressorFn?: (prompt: string, system: string) => Promise<string>;
  historyDir?: string;
  contextWindowTokens?: number;
}
export interface Progress {
  isActive: boolean;
  phase: "initializing" | "generating" | "compressing" | "reflecting" | "complete" | "error";
  phaseDetail: string;
  currentChunk: number;
  maxChunks: number;
  tokensUsed: number;
  tokensSaved: number;
  carryoverSize: number;
  startTime: number;
  lastUpdateTime: number;
  logs: string[];
  completedChunks: ChunkInfo[];
}
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}
export class MarkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkerError";
  }
}
const estimate = (text: string) => Math.ceil(text.length / 4);
export function resolveConfig(config: Partial<ChunkConfig> = {}, window = 128000): ChunkConfig {
  const c = { chunkSize: 8000, maxChunks: 24, carryoverTokens: 800, overlapTokens: 0, ...config };
  for (const [key, min, max] of [
    ["chunkSize", 1000, 128000],
    ["maxChunks", 1, 32],
    ["carryoverTokens", 128, 32768],
    ["overlapTokens", 0, 4096],
  ] as const) {
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max)
      throw new ConfigValidationError(key + " is outside the supported bounds");
  }
  if (c.chunkSize < 400 + c.carryoverTokens + 1200 + c.overlapTokens)
    throw new ConfigValidationError("chunkSize must fit framing, carryover, overlap and output");
  if (c.chunkSize > window) throw new ConfigValidationError("chunkSize exceeds the model context window");
  return c;
}
export function modelTotals(n: number, k = { F: 400, G: 200, S: 300, O: 1200, C: 800 }) {
  if (!Number.isInteger(n) || n < 0)
    throw new ConfigValidationError("Step count must be a nonnegative integer");
  const naiveTotal = n * (k.F + k.G + k.S) + (k.O * n * (n - 1)) / 2,
    markovianTotal = n * (k.F + k.G + k.C + k.S),
    savings = naiveTotal - markovianTotal;
  return { naiveTotal, markovianTotal, savings, efficiency: naiveTotal ? savings / naiveTotal : 0 };
}
export function runEfficiency(chunks: Pick<ChunkInfo, "tokens">[], c: ChunkConfig) {
  let prefix = 0,
    standardCost = 0;
  for (const x of chunks) {
    prefix += x.tokens;
    standardCost += prefix;
  }
  const markovianCost = chunks.length * c.carryoverTokens + prefix,
    tokensSaved = Math.max(0, standardCost - markovianCost);
  return {
    totalTokensUsed: prefix,
    standardCost,
    markovianCost,
    tokensSaved,
    efficiencyPercent: standardCost ? (100 * tokensSaved) / standardCost : 0,
  };
}
export function projectionCurve(c: ChunkConfig, steps = 10) {
  return Array.from({ length: steps }, (_, i) => ({
    step: i + 1,
    standard: (i + 1) * c.chunkSize,
    markovian: c.carryoverTokens + c.chunkSize,
  }));
}
export function parseMarkers(text: string): { content: string; state?: string; done: boolean } {
  if (/\[NEEDS_TOOL\b|\[NEEDS_CLARIFICATION\b|<NEEDS_(?:TOOL|CLARIFICATION)\b/i.test(text))
    throw new MarkerError("Pause markers require an explicit host adapter");
  const pattern =
    /\[(STATE_CHECKPOINT|STATE|TASK_COMPLETE|FINAL)\]|@@@(STATE|FINAL)@@@|---(STATE|FINAL)---|<(CARRYOVER)>([\s\S]*?)<\/CARRYOVER>|<DONE\s*\/?>/gi;
  const matches = [...text.matchAll(pattern)];
  if (matches.length > 1) throw new MarkerError("A chunk must have only one state or completion marker");
  if (!matches.length) {
    if (/\[(?:STATE_CHECKPOINT|TASK_COMPLETE|FINAL|STATE)\b|<CARRYOVER\b|<DONE\b/i.test(text))
      throw new MarkerError("Malformed control marker");
    return { content: text.trim(), done: false };
  }
  const marker = matches[0]!,
    name = marker[1] ?? marker[2] ?? marker[3] ?? marker[4] ?? "DONE",
    done = /TASK_COMPLETE|FINAL|DONE/i.test(name);
  const state = done ? undefined : (marker[5] ?? text.slice(marker.index! + marker[0].length).trim());
  if (state && /\[(?:STATE_CHECKPOINT|TASK_COMPLETE)|<CARRYOVER/i.test(state))
    throw new MarkerError("Nested state marker");
  return { content: text.slice(0, marker.index).trim(), state, done };
}
function fit(text: string, budget: number): string {
  return text.length <= budget
    ? text
    : text
        .slice(-budget)
        .replace(/^\S*\s/, "")
        .trim();
}
function measuredOutput(metadata: unknown): number | undefined {
  if (!metadata || typeof metadata !== "object") return;
  const usage = "usage" in metadata ? metadata.usage : undefined;
  if (!usage || typeof usage !== "object") return;
  const n = "output_tokens" in usage ? usage.output_tokens : undefined;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}
export class History {
  private entries: MarkovianRun[] = [];
  constructor(private dir?: string) {
    if (dir && existsSync(join(dir, "history.json")))
      this.entries = JSON.parse(readFileSync(join(dir, "history.json"), "utf8")) as MarkovianRun[];
  }
  private flush() {
    if (this.dir) {
      mkdirSync(this.dir, { recursive: true });
      const path = join(this.dir, "history.json");
      writeFileSync(path + ".tmp", JSON.stringify(this.entries));
      renameSync(path + ".tmp", path);
    }
  }
  record(run: MarkovianRun) {
    this.entries.push(structuredClone(run));
    this.flush();
  }
  list(limit = 50) {
    return structuredClone(this.entries.slice(-limit).reverse());
  }
  get(id: string) {
    return this.list(this.entries.length).find((r) => r.id === id) ?? null;
  }
  delete(id: string) {
    this.entries = this.entries.filter((r) => r.id !== id);
    this.flush();
  }
  clear() {
    this.entries = [];
    this.flush();
  }
  cumulative() {
    const runs = this.entries;
    return {
      totalRuns: runs.length,
      completedRuns: runs.filter((r) => r.status === "completed").length,
      totalTokensUsed: runs.reduce((n, r) => n + r.totalTokensUsed, 0),
      totalTokensSaved: runs.reduce((n, r) => n + r.totalTokensSaved, 0),
      averageEfficiency: runs.length ? runs.reduce((n, r) => n + r.efficiencyPercent, 0) / runs.length : 0,
      totalChunksProcessed: runs.reduce((n, r) => n + r.chunks.length, 0),
      lastRunTimestamp: runs.at(-1)?.timestamp ?? 0,
      efficiencyHistory: runs.map((r) => ({
        timestamp: r.timestamp,
        efficiency: r.efficiencyPercent,
        tokensSaved: r.totalTokensSaved,
      })),
    };
  }
}
export class Markovian {
  readonly config: ChunkConfig;
  readonly history: History;
  private listeners = new Set<(s: Progress) => void>();
  private clock: () => number;
  private progress?: Progress;
  constructor(private options: EngineOptions = {}) {
    this.config = resolveConfig(options.chunkConfig, options.contextWindowTokens);
    this.clock = options.clock ?? Date.now;
    this.history = new History(options.historyDir);
  }
  onProgress(listener: (s: Progress) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(phase: Progress["phase"], detail: string, extra: Partial<Progress> = {}) {
    const now = this.clock();
    const defaults: Progress = {
      isActive: true,
      phase: "initializing",
      phaseDetail: "",
      currentChunk: 0,
      maxChunks: this.config.maxChunks,
      tokensUsed: 0,
      tokensSaved: 0,
      carryoverSize: 0,
      startTime: now,
      lastUpdateTime: now,
      logs: [],
      completedChunks: [],
    };
    this.progress = {
      ...defaults,
      ...this.progress,
      ...extra,
      phase,
      phaseDetail: detail,
      lastUpdateTime: now,
    };
    this.progress.logs = [...this.progress.logs, detail].slice(-15);
    for (const fn of this.listeners) {
      try {
        fn(structuredClone(this.progress));
      } catch {
        /* A display listener cannot stop the engine. */
      }
    }
  }
  private async compress(text: string, state: string | undefined, previous: string, signal?: AbortSignal) {
    const budget = this.config.carryoverTokens * 4;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (state && state.length >= 24 && state.length <= budget) return { state, cascade: 1 };
    if (this.options.compressorFn) {
      try {
        const summary = await this.options.compressorFn(
          "Previous state:\n" + previous + "\nCurrent output tail:\n" + text.slice(-2000),
          "Return 3-5 critical points using COMPLETED, REMAINING, DECISIONS and CONTEXT labels. Maximum " +
            budget +
            " characters.",
        );
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        if (summary.trim().length >= 24 && summary.length <= budget)
          return { state: summary.trim(), cascade: 2 };
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    const points = (state ?? text)
      .split(/\n|(?<=[.!?])\s/)
      .filter((s) => /Therefore|Key insight|Status|Next|DECISIONS:|REMAINING:|CONTEXT:/i.test(s))
      .slice(0, 5)
      .join("; ");
    if (points.length >= 24 && points.length <= budget) return { state: points, cascade: 3 };
    const prefix =
      "COMPLETED: recent output retained\nREMAINING: continue\nDECISIONS: see context\nCONTEXT: ";
    const tail = fit((previous + "\n" + (state ?? text)).trim(), Math.max(0, budget - prefix.length));
    return { state: prefix + tail, cascade: 4 };
  }
  async run(options: RunOptions): Promise<MarkovianRun> {
    const start = this.clock(),
      goal = options.goal ?? options.prompt ?? "",
      cfg = structuredClone(this.config);
    const run: MarkovianRun = {
      id: randomUUID(),
      timestamp: start,
      prompt: goal.slice(0, 2000),
      mode: options.mode ?? "ARCHITECT",
      chunkConfig: cfg,
      chunks: [],
      status: "max-chunks",
      output: "",
      tokenLabel: "estimated",
      efficiencyLabel: "modeled",
      totalTokensUsed: 0,
      totalTokensSaved: 0,
      efficiencyPercent: 0,
      durationMs: 0,
    };
    let carryover = "",
      last = "",
      allMeasured = true;
    this.progress = undefined;
    this.emit("initializing", "Starting bounded reasoning");
    const generator = options.generator ?? this.options.generator;
    try {
      if (!generator && !options.stepFn) throw new Error("A generator is required");
      for (let step = 1; step <= cfg.maxChunks; step++) {
        if (options.abortSignal?.aborted) {
          run.status = "aborted";
          break;
        }
        let prompt =
          (step === 1 ? goal : "Original goal: " + goal.slice(0, 200)) +
          "\n" +
          (step === 1 ? (options.memoryContext ?? "") : "Carryover:\n" + carryover);
        if (step > 1 && cfg.overlapTokens) prompt += "\n[OVERLAP]\n" + last.slice(-cfg.overlapTokens * 4);
        const system =
          (run.mode === "RESEARCH"
            ? "Analyze evidence and log actions using >>. "
            : "Analyze and carry out the next bounded step. ") +
          "End with exactly one [STATE_CHECKPOINT] followed by COMPLETED / REMAINING / DECISIONS / CONTEXT state, or [TASK_COMPLETE] when done. Control markers are not user-facing prose.";
        this.emit("generating", "Generating chunk " + step, {
          currentChunk: step,
          carryoverSize: estimate(carryover),
        });
        const reply = options.stepFn
          ? { text: (await options.stepFn({ goal, carryover, step, prompt })).content, metadata: undefined }
          : await generator!(
              prompt,
              step === 1 ? (options.attachments ?? []) : [],
              system,
              () => {
                this.emit("generating", "Receiving chunk " + step);
              },
              options.abortSignal,
            );
        const parsed = parseMarkers(reply.text),
          measured = measuredOutput(reply.metadata),
          tokens = measured ?? estimate(parsed.content);
        allMeasured = allMeasured && measured !== undefined;
        const chunk: ChunkInfo = {
          id: step,
          tokens,
          carryover,
          content: parsed.content,
          tokenLabel: measured === undefined ? "estimated" : "measured",
        };
        run.chunks.push(chunk);
        last = parsed.content;
        run.output = run.chunks.map((c) => c.content).join("\n\n");
        options.onStream?.(chunk.content);
        if (options.abortSignal?.aborted) {
          run.status = "aborted";
          await options.onChunk?.(chunk);
          break;
        }
        this.emit("compressing", "Compressing state for chunk " + step);
        const next = await this.compress(parsed.content, parsed.state, carryover, options.abortSignal);
        carryover = next.state;
        chunk.nextCarryover = carryover;
        chunk.cascadeLevelUsed = next.cascade;
        const accounting = runEfficiency(run.chunks, cfg);
        this.emit("compressing", "Chunk " + step + " recorded", {
          tokensUsed: accounting.totalTokensUsed,
          tokensSaved: accounting.tokensSaved,
          carryoverSize: estimate(carryover),
          completedChunks: structuredClone(run.chunks),
        });
        await options.onChunk?.(structuredClone(chunk));
        if (parsed.done || options.stopWhen?.({ step, carryover })) {
          run.status = "completed";
          break;
        }
      }
      if (
        run.status === "completed" &&
        run.chunks.length &&
        options.reflect !== false &&
        !options.abortSignal?.aborted &&
        generator
      ) {
        this.emit("reflecting", "Checking the completed reasoning");
        try {
          const reflected = await generator(
            "Ratify the result against the original goal. Do not introduce unsupported facts.\nGoal: " +
              goal.slice(0, 2000) +
              "\nFinal state: " +
              carryover +
              "\nOutput:\n" +
              run.output.slice(-12000),
            [],
            "Return a concise conclusion with [TASK_COMPLETE].",
            undefined,
            options.abortSignal,
          );
          run.reflection = parseMarkers(reflected.text).content;
        } catch (error) {
          run.reflectionError = error instanceof Error ? error.message : "Reflection failed";
        }
      }
    } catch (error) {
      run.status = options.abortSignal?.aborted ? "aborted" : "errored";
      run.error = error instanceof Error ? error.message : "Chunk failed";
      this.emit("error", run.error, { isActive: false });
    }
    const totals = runEfficiency(run.chunks, cfg);
    run.totalTokensUsed = totals.totalTokensUsed;
    run.totalTokensSaved = totals.tokensSaved;
    run.efficiencyPercent = totals.efficiencyPercent;
    run.durationMs = this.clock() - start;
    run.tokenLabel = run.chunks.length && allMeasured ? "measured" : "estimated";
    this.emit(run.status === "errored" ? "error" : "complete", run.status, { isActive: false });
    this.history.record(run);
    return run;
  }
}
