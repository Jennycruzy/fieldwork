import { z } from "zod";

// What the Planner returns.
const OUTPUTS = ["ranking", "comparison", "trend", "list"];
// A refusal has nothing to analyse, so its analysis, measures and output are not held to the plan shape
// (a recorded refusal arrived with analysis.basis "none" and no rank_measure).
const refusalShape = (v: unknown) => {
  if (!v || typeof v !== "object" || (v as { in_scope?: unknown }).in_scope !== false) return v;
  const o = v as Record<string, unknown>;
  return {
    ...o,
    analysis: undefined,
    measures: [],
    years: null,
    output: OUTPUTS.includes(o.output as string) ? o.output : "list",
  };
};
export const PlanSchema = z.preprocess(
  refusalShape,
  z
    .object({
      in_scope: z.boolean(),
      scope_limit: z.enum(["place", "personal", "non_public"]).optional().nullable(),
      out_of_scope_reason: z.string().optional().nullable(),
      geography: z.enum(["tract", "council_district", "city"]).nullable(),
      years: z
        .object({ from: z.number().int().optional().nullable(), to: z.number().int().optional().nullable() })
        .optional()
        .nullable(),
      measures: z
        .array(
          z.object({
            id: z.string(),
            describe: z.string(),
            kind: z.enum(["health_estimate", "city_records", "environmental_records"]),
            search_terms: z.array(z.string()).min(1).max(4),
          }),
        )
        .max(4),
      analysis: z
        .object({
          basis: z.enum(["counts", "rates", "mixed", "scores"]),
          denominator: z.enum(["none", "residents", "adults"]),
          relationship: z.boolean(),
          reason: z.string(),
          rank_measure: z
            .string()
            .nullable()
            .transform((v) => v ?? ""),
        })
        .optional(),
      output: z.enum(["ranking", "comparison", "trend", "list"]),
    })
    // A refusal has nothing to map, so the model may leave geography empty; an in-scope plan may not.
    .superRefine((v, ctx) => {
      if (v.in_scope && !v.geography)
        ctx.addIssue({ code: "custom", path: ["geography"], message: "Required for an in-scope plan" });
    })
    .transform((v) => ({ ...v, geography: v.geography ?? "city" })),
);
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
      fields: z.array(z.string()).min(1).max(80),
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

export type Step =
  | "PLAN"
  | "FIND"
  | "WIRE"
  | "BRIDGE"
  | "JOIN"
  | "EVALUATE"
  | "WRITE"
  | "DONE"
  | "REFUSED"
  | "PARTIAL"
  | "FAILED";

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
