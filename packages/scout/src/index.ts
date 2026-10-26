import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { IntentRegistry, readData } from "./registry.js";
import { Scorer } from "./scoring.js";
import { canonical, assertContract, detectInjection, MonotonicId, redact, signContract } from "./security.js";
import {
  ScoutError,
  type RegistryData,
  type ScoutInput,
  type Decision,
  type Risk,
  type ExecutionContract,
  type ModelProfile,
  type ToolDefinition,
} from "./types.js";
export * from "./types.js";
export { IntentRegistry } from "./registry.js";
export { detectInjection, redact, verifySignature } from "./security.js";
type Policy = {
  version?: string;
  blockedIntents?: string[];
  maxCostUSD?: number;
  maxLatencyMs?: number;
  ttlMs?: number;
};
export interface ScoutOptions {
  intentRegistry: string | RegistryData | IntentRegistry;
  policyPack?: string[];
  policy?: Policy;
  tools?: ToolDefinition[];
  modelProfiles?: ModelProfile[];
  signingKey?: string | Uint8Array;
  clock?: () => number;
  stage2?: (prompt: string) => Promise<Record<string, number>>;
}
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
};
export class Scout {
  readonly registry: IntentRegistry;
  readonly startupScanMs: number;
  private scorer: Scorer;
  private key: string | Uint8Array;
  private clock: () => number;
  private ids = new MonotonicId();
  private policy: Policy;
  constructor(private options: ScoutOptions) {
    this.registry = freeze(IntentRegistry.load(options.intentRegistry));
    this.scorer = new Scorer(this.registry.intents);
    this.key = options.signingKey ?? randomBytes(32);
    this.clock = options.clock ?? Date.now;
    this.policy = { version: "default+adversarial-tight/1", ttlMs: 300000, ...options.policy };
    for (const name of options.policyPack ?? ["default"]) {
      if (["default", "adversarial-tight"].includes(name)) continue;
      this.policy = { ...this.policy, ...(readData(name) as Policy) };
    }
    if (!Number.isFinite(this.policy.ttlMs) || this.policy.ttlMs! <= 0 || this.policy.ttlMs! > 300000)
      throw new ScoutError("Lifetime must be within five minutes", "INVALID_POLICY");
    let max = 0;
    for (const prompt of ["hello", "summarize account status", "draft a report and schedule a review"]) {
      const start = performance.now();
      this.scorer.scan({ prompt, surface: "chat" });
      max = Math.max(max, performance.now() - start);
    }
    this.startupScanMs = max;
    if (max >= 16) throw new ScoutError("Full registry trigger scan exceeded 16 ms", "SLOW_REGISTRY");
  }
  async decide(input: ScoutInput): Promise<Decision> {
    const start = performance.now(),
      now = this.clock(),
      user = input.user ?? { id: "anonymous", role: "anonymous" };
    const redacted = redact(input.prompt),
      injection = detectInjection(
        input.context?.guardText ?? input.prompt,
        input.context?.untrusted !== true,
      );
    let semantic: Record<string, number> = {},
      stage2: Decision["stage2"] = "skipped";
    if (this.options.stage2 && !injection.detected)
      try {
        semantic = await this.options.stage2(redacted.sanitized);
        stage2 = "used";
      } catch {
        /* Deterministic routing remains available. */
      }
    const candidates = this.scorer.scan({ ...input, prompt: redacted.sanitized }, semantic);
    let primary = this.registry.intents.find((i) => i.id === candidates[0]?.intent)!;
    const top = candidates[0]!,
      second = candidates[1];
    if (top.score < 0.4) primary = this.registry.intents.find((i) => i.id === "GENERAL")!;
    const risk: Risk = {
      level: primary.riskClass,
      flags: [],
      redactions: redacted.redactions,
      approvals: input.context?.approvals ?? [],
      injection,
    };
    const block = (kind: string, reason: string) => {
      risk.level = "block";
      risk.flags.push({ kind, reason });
      risk.reason = reason;
    };
    if (injection.detected) block("injection", "Untrusted instructions were detected");
    if (!primary.roles.includes("*") && !primary.roles.includes(user.role))
      block("role", "Role is not allowed for this intent");
    if (!primary.surfaces.includes(input.surface)) block("surface", "Surface is not allowed for this intent");
    if (this.policy.blockedIntents?.includes(primary.id)) block("policy", "Policy blocks this intent");
    const parameters: Record<string, unknown> = { ...input.context?.parameters },
      missing: string[] = [];
    const props = primary.parameters.properties ?? {};
    for (const [name, schema] of Object.entries(props)) {
      if (parameters[name] === undefined && schema.type === "integer") {
        const m = input.prompt.match(/\b(?:top|give me|find me)\s+(\d+)\b/i);
        if (m) parameters[name] = Number(m[1]);
      }
      const v = parameters[name];
      if (v === undefined) {
        if (primary.parameters.required?.includes(name)) missing.push(name);
        continue;
      }
      if (
        (schema.type === "integer" && !Number.isInteger(v)) ||
        (schema.type === "number" && typeof v !== "number") ||
        (schema.type === "string" && typeof v !== "string") ||
        (schema.type === "array" && !Array.isArray(v)) ||
        (schema.enum && !schema.enum.includes(v)) ||
        (typeof v === "number" &&
          ((schema.minimum !== undefined && v < schema.minimum) ||
            (schema.maximum !== undefined && v > schema.maximum)))
      )
        block("parameter", "Parameter validation failed");
    }
    for (const key of Object.keys(parameters)) if (!(key in props)) delete parameters[key];
    // Credential and personal-data spans are never copied into the signed parameters.
    const sanitize = (value: unknown): unknown =>
      typeof value === "string"
        ? redact(value).sanitized
        : Array.isArray(value)
          ? value.map(sanitize)
          : value && typeof value === "object"
            ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)]))
            : value;
    const safeParameters = sanitize(parameters) as Record<string, unknown>;
    if (primary.riskClass === "high") risk.approvalsRequired = ["user-confirm"];
    const segments = input.prompt.split(/\s+(?:and then|and|then)\s+|;\s*/i);
    const intents: { id: string; span?: { start: number; end: number } }[] = [];
    let offset = 0;
    for (const segment of segments) {
      const choice = this.scorer.scan({ ...input, prompt: segment })[0];
      if (choice && choice.score >= 0.55 && !intents.some((i) => i.id === choice.intent))
        intents.push({
          id: choice.intent,
          span: {
            start: input.prompt.indexOf(segment, offset),
            end: input.prompt.indexOf(segment, offset) + segment.length,
          },
        });
      offset = input.prompt.indexOf(segment, offset) + segment.length;
    }
    if (!intents.some((i) => i.id === primary.id)) intents.unshift({ id: primary.id });
    const capabilities = [
      ...new Set(
        (intents.length > 1
          ? intents.map((i) => this.registry.intents.find((r) => r.id === i.id)!)
          : [primary]
        ).flatMap((i) => i.capabilities),
      ),
    ];
    // An allowed primary cannot smuggle a denied secondary into a composed plan.
    for (const item of intents) {
      const i = this.registry.intents.find((r) => r.id === item.id)!;
      if ((!i.roles.includes("*") && !i.roles.includes(user.role)) || !i.surfaces.includes(input.surface))
        block("secondary-policy", "Secondary intent is not authorized");
      if (i.riskClass === "high") risk.approvalsRequired = ["user-confirm"];
    }
    const tools = this.options.tools ?? [],
      dataClass = input.context?.dataClass ?? "public";
    const toolPlan = capabilities.map((capability) => {
      const tool = tools
        .filter(
          (t) =>
            t.capability === capability &&
            (!t.availability || t.availability()) &&
            (!t.surfaces || t.surfaces.includes(input.surface)) &&
            (!t.requiredPermissions || t.requiredPermissions.every((p) => user.permissions?.includes(p))),
        )
        .sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0) || (a.latencyP95Ms ?? 0) - (b.latencyP95Ms ?? 0))[0];
      return { capability, tool: tool?.toolId ?? null, input: safeParameters, available: !!tool };
    });
    const unavailable = toolPlan.filter((t) => !t.available).map((t) => t.capability);
    const profiles = (
      this.options.modelProfiles ?? [
        {
          id: "local-rules",
          provider: "local",
          model: "deterministic",
          local: true,
          dataClasses: ["public", "internal", "pii"],
          capabilities: [],
          cost: 0,
          latencyP95Ms: 0,
        },
      ]
    )
      .filter(
        (p) =>
          p.dataClasses.includes(dataClass) &&
          p.cost <= (this.policy.maxCostUSD ?? Infinity) &&
          p.latencyP95Ms <= (this.policy.maxLatencyMs ?? Infinity),
      )
      .sort((a, b) => a.cost - b.cost || a.latencyP95Ms - b.latencyP95Ms);
    const modelProfile = profiles[0] ?? {
      id: "unavailable",
      provider: "none",
      model: "none",
      local: true,
      dataClasses: [],
      capabilities: [],
      cost: 0,
      latencyP95Ms: 0,
    };
    if (!profiles.length) block("model-clearance", "No model has clearance within budget");
    const id = this.ids.next(now),
      intent = {
        primary: { id: primary.id, version: primary.version },
        parameters: safeParameters,
        references: sanitize(input.context?.references ?? {}) as Record<string, unknown>,
        confidence: primary.id === "GENERAL" && top.score < 0.4 ? 0 : top.score,
        alternates: candidates.slice(1, 4),
      };
    const unsigned: Omit<ExecutionContract, "signature"> = {
      contractId: id,
      ...(input.context?.parentId ? { parentId: input.context.parentId } : {}),
      traceId: input.context?.traceId ?? id,
      intent,
      risk,
      toolPlan,
      modelProfile,
      scope: {
        user,
        surface: input.surface,
        capabilities: risk.level === "block" ? [] : capabilities,
        budget: { costMaxUSD: this.policy.maxCostUSD ?? 0 },
      },
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.policy.ttlMs!).toISOString(),
      registryVersion: this.registry.version,
      policyPackVersion: this.policy.version ?? "custom/1",
      signedBy: "scout",
    };
    const executionContract = freeze({ ...unsigned, signature: signContract(unsigned, this.key) });
    const clarification =
      risk.level !== "block" &&
      ((top.score >= 0.4 && top.score < 0.55) ||
        (top.score >= 0.55 && top.score < 0.8 && second && top.score - second.score <= 0.05) ||
        missing.length > 0 ||
        (primary.riskClass === "high" && top.score < 0.95))
        ? {
            question: missing.length ? "Please provide: " + missing.join(", ") : "Which action did you mean?",
            options: candidates.slice(0, 4).map((c) => ({ label: c.intent, intent: c.intent })),
          }
        : undefined;
    return {
      candidates,
      intent,
      risk: executionContract.risk,
      executionContract,
      toolPlan: executionContract.toolPlan,
      sanitizedPrompt: redacted.sanitized,
      intents,
      ...(unavailable.length
        ? { routingError: { code: "CAPABILITY_UNAVAILABLE", capabilities: unavailable } }
        : {}),
      ...(clarification ? { clarification } : {}),
      latencyMs: performance.now() - start,
      stage2,
    };
  }
  verify(
    contract: ExecutionContract,
    capability?: string,
    user?: { id: string; role: string },
    surface?: string,
  ) {
    assertContract(contract, this.key, this.clock(), this.registry.version, capability);
    if (user && (contract.scope.user.id !== user.id || contract.scope.user.role !== user.role))
      throw new ScoutError("Request identity changed", "SCOPE_MISMATCH");
    if (surface && contract.scope.surface !== surface)
      throw new ScoutError("Request surface changed", "SCOPE_MISMATCH");
  }
  async execute(contract: ExecutionContract, capability: string, input: Record<string, unknown> = {}) {
    this.verify(contract, capability);
    const step = contract.toolPlan.find((t) => t.capability === capability),
      tool = this.options.tools?.find((t) => t.toolId === step?.tool && t.capability === capability);
    if (!tool?.invoke || !step?.available || (tool.availability && !tool.availability()))
      throw new ScoutError("No available registered adapter", "CAPABILITY_UNAVAILABLE");
    for (const required of tool.requires ?? [])
      if (!contract.scope.capabilities.includes(required))
        throw new ScoutError("Tool dependency is outside scope", "SCOPE_MISMATCH");
    if (Object.keys(input).length && canonical(input) !== canonical(step.input))
      throw new ScoutError("Tool inputs differ from the signed plan", "SCOPE_MISMATCH");
    return tool.invoke(step.input);
  }
  replan(previous: ExecutionContract, input: ScoutInput) {
    if (!previous.signature) throw new ScoutError("Cannot replan unsigned contract", "INVALID_SIGNATURE");
    // Expired contracts can be replanned, but their signatures still have to be authentic.
    const { signature, ...unsigned } = previous;
    if (signContract(unsigned, this.key) !== signature)
      throw new ScoutError("Cannot replan tampered contract", "INVALID_SIGNATURE");
    return this.decide({
      ...input,
      context: { ...input.context, traceId: previous.traceId, parentId: previous.contractId },
    });
  }
}
