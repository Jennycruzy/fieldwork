import { z } from "zod";

// What the Planner returns.
export const PlanSchema = z.object({
  in_scope: z.boolean(),
  out_of_scope_reason: z.string().optional().nullable(),
  geography: z.enum(["tract", "council_district", "city"]),
  years: z.object({ from: z.number().int().optional().nullable(), to: z.number().int().optional().nullable() }).optional().nullable(),
  measures: z
    .array(
      z.object({
        id: z.string(),
        describe: z.string(),
        kind: z.enum(["health_estimate", "city_records"]),
        search_terms: z.array(z.string()).min(1).max(4),
      }),
    )
    .max(4),
  output: z.enum(["ranking", "comparison", "trend", "list"]),
});
export type Plan = z.infer<typeof PlanSchema>;

// What the Finder picks for each measure.
export const ChoiceSchema = z.object({
  choices: z.array(
    z.object({
      measure_id: z.string(),
      candidate_index: z.number().int().nonnegative(),
      reason: z.string(),
    }),
  ),
});
export type Choices = z.infer<typeof ChoiceSchema>;

// What the Wirer decides per chosen source (the URL itself is built by code).
export const WiringSchema = z.object({
  sources: z.array(
    z.object({
      measure_id: z.string(),
      where: z.string().describe("filter in the source's own query language; '1=1' for none"),
      fields: z.array(z.string()).min(1).max(12),
      group_field: z.string().optional().nullable(),
    }),
  ),
});
export type Wiring = z.infer<typeof WiringSchema>;

export const SqlSchema = z.object({ sql: z.string().min(6), explain: z.string().optional() });

export const VerdictSchema = z.object({
  verdict: z.enum(["APPROVE", "REVISE"]),
  target: z.enum(["join", "wire", "plan"]).optional().nullable(),
  instruction: z.string().optional().nullable(),
  reasons: z.array(z.string()).max(6),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const AnswerSchema = z.object({
  headline: z.string(),
  points: z.array(z.string()).max(6),
  how_sure: z.string(),
  caveats: z.array(z.string()).max(6),
});
export type Answer = z.infer<typeof AnswerSchema>;

export type Step = "PLAN" | "FIND" | "WIRE" | "BRIDGE" | "JOIN" | "EVALUATE" | "WRITE" | "DONE" | "REFUSED" | "PARTIAL" | "FAILED";

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
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
  sql?: string;
  zetarisMs?: number;
  rows?: number;
}
