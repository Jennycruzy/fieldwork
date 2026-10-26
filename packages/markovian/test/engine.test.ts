import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Markovian, History, ConfigValidationError } from "../src/index.js";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
test("continuations carry bounded state while memory and attachments enter only the first chunk", async () => {
  const prompts: string[] = [],
    attachments: unknown[] = [];
  const m = new Markovian({
    chunkConfig: { chunkSize: 4000, carryoverTokens: 512, maxChunks: 3, overlapTokens: 32 },
  });
  const run = await m.run({
    goal: "Describe the checked rows",
    memoryContext: "INITIAL_MEMORY",
    attachments: [{ name: "data", content: "INITIAL_ATTACHMENT" }],
    reflect: false,
    generator: async (p, a) => {
      prompts.push(p);
      attachments.push(a);
      return {
        text:
          prompts.length === 1
            ? "Verified first chunk body [STATE_CHECKPOINT]\nCOMPLETED: first chunk checked\nREMAINING: second chunk\nDECISIONS: preserve exact counts\nCONTEXT: count=71"
            : "Verified second chunk body [TASK_COMPLETE]",
      };
    },
  });
  expect(run.status).toBe("completed");
  expect(prompts[0]).toContain("INITIAL_MEMORY");
  expect(prompts[1]).not.toContain("INITIAL_MEMORY");
  expect(attachments[1]).toEqual([]);
  expect(prompts[1]).toContain("count=71");
  expect(prompts[1]).toContain("[OVERLAP]");
  expect(run.chunks.every((c) => (c.nextCarryover?.length ?? 0) <= 512 * 4)).toBe(true);
});
test("abort after generation preserves checked output and never calls compression", async () => {
  const controller = new AbortController(),
    compressorFn = vi.fn(async () => "must not run");
  const m = new Markovian({ compressorFn });
  const result = await m.run({
    goal: "Abort check",
    abortSignal: controller.signal,
    reflect: false,
    generator: async () => {
      controller.abort();
      return { text: "Partial output retained." };
    },
  });
  expect(result.status).toBe("aborted");
  expect(result.chunks).toHaveLength(1);
  expect(result.output).toContain("Partial output");
  expect(compressorFn).not.toHaveBeenCalled();
});
test("compression falls back deterministically within its configured state budget", async () => {
  let calls = 0;
  const m = new Markovian({
    chunkConfig: { chunkSize: 4000, carryoverTokens: 128, maxChunks: 2 },
    compressorFn: async () => {
      throw new Error("offline");
    },
  });
  const result = await m.run({
    goal: "Fallback check",
    reflect: false,
    generator: async () => {
      calls++;
      return { text: "Long content ".repeat(400) + (calls === 2 ? " [TASK_COMPLETE]" : "") };
    },
  });
  expect(result.status).toBe("completed");
  expect(result.chunks[0]?.cascadeLevelUsed).toBe(4);
  expect(result.chunks[0]?.nextCarryover?.startsWith("COMPLETED:")).toBe(true);
  expect(result.chunks.every((c) => (c.nextCarryover?.length ?? 0) <= 512)).toBe(true);
});
test("provider-reported output tokens are measured while savings remain explicitly modeled", async () => {
  const run = await new Markovian().run({
    goal: "Measured check",
    reflect: false,
    generator: async () => ({
      text: "Body [TASK_COMPLETE]",
      metadata: { usage: { input_tokens: 30, output_tokens: 41 } },
    }),
  });
  expect(run.tokenLabel).toBe("measured");
  expect(run.totalTokensUsed).toBe(41);
  expect(run.efficiencyLabel).toBe("modeled");
});
test("persistent history keeps each run's configuration and survives a new engine", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fieldwork-markovian-"));
  dirs.push(dir);
  const m = new Markovian({ historyDir: dir, chunkConfig: { chunkSize: 4000, carryoverTokens: 512 } });
  const run = await m.run({
    goal: "History check",
    reflect: false,
    generator: async () => ({ text: "Done [TASK_COMPLETE]" }),
  });
  const history = new History(dir);
  expect(history.get(run.id)?.chunkConfig.carryoverTokens).toBe(512);
  expect(history.cumulative().completedRuns).toBe(1);
  history.delete(run.id);
  expect(new History(dir).list()).toEqual([]);
});
test("malformed or multiple markers are recorded as errors instead of leaking control text", async () => {
  for (const text of ["body [STATE_CHECKPOINT", "body [STATE_CHECKPOINT] state [TASK_COMPLETE]"]) {
    const run = await new Markovian().run({
      goal: "Marker check",
      generator: async () => ({ text }),
      reflect: false,
    });
    expect(run.status).toBe("errored");
    expect(run.output).not.toContain("STATE_CHECKPOINT");
  }
  expect(() => new Markovian({ chunkConfig: { chunkSize: 4000 }, contextWindowTokens: 3000 })).toThrow(
    ConfigValidationError,
  );
});
