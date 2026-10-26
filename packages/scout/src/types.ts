export type RiskLevel = "low" | "medium" | "high" | "block";
export interface UserRef {
  id: string;
  role: string;
  permissions?: string[];
}
export interface ParameterSchema {
  type?: string;
  properties?: Record<
    string,
    { type?: string; enum?: unknown[]; minimum?: number; maximum?: number; items?: unknown }
  >;
  required?: string[];
}
export interface Intent {
  id: string;
  category: string;
  description: string;
  parameters: ParameterSchema;
  capabilities: string[];
  riskClass: "low" | "medium" | "high";
  surfaces: string[];
  roles: string[];
  examples: string[];
  version: number;
}
export interface RegistryData {
  version?: number;
  registryVersion?: number;
  intents: Intent[];
}
export interface Candidate {
  intent: string;
  score: number;
  rawScore: number;
  lexical: number;
  semantic: number;
  contextual: number;
  recency: number;
  span?: { start: number; end: number };
}
export interface Risk {
  level: RiskLevel;
  flags: { kind: string; reason: string }[];
  redactions: { kind: string; start: number; end: number }[];
  approvals: { kind: string; at: string; decision?: string }[];
  reason?: string;
  approvalsRequired?: string[];
  injection?: { detected: boolean; kind: string; score: number; evidence: string[] };
}
export interface ToolStep {
  capability: string;
  tool: string | null;
  input: Record<string, unknown>;
  available: boolean;
}
export interface ModelProfile {
  id: string;
  provider: string;
  model: string;
  local: boolean;
  dataClasses: string[];
  capabilities: string[];
  cost: number;
  latencyP95Ms: number;
}
export interface ExecutionContract {
  contractId: string;
  parentId?: string;
  traceId: string;
  intent: {
    primary: { id: string; version: number };
    parameters: Record<string, unknown>;
    references: Record<string, unknown>;
    confidence: number;
    alternates: Candidate[];
  };
  risk: Risk;
  toolPlan: ToolStep[];
  modelProfile: ModelProfile;
  scope: {
    user: UserRef;
    surface: string;
    capabilities: string[];
    budget?: { costMaxUSD?: number; tokensMax?: number };
  };
  issuedAt: string;
  expiresAt: string;
  registryVersion: number;
  policyPackVersion: string;
  signature: string;
  signedBy: "scout";
}
export interface ScoutInput {
  prompt: string;
  surface: string;
  user?: UserRef;
  context?: {
    activeIntent?: string;
    parameters?: Record<string, unknown>;
    references?: Record<string, unknown>;
    guardText?: string;
    untrusted?: boolean;
    approvals?: Risk["approvals"];
    traceId?: string;
    parentId?: string;
    dataClass?: string;
  };
}
export interface Decision {
  candidates: Candidate[];
  intent: ExecutionContract["intent"];
  risk: Risk;
  executionContract: ExecutionContract;
  toolPlan: ToolStep[];
  sanitizedPrompt: string;
  intents: { id: string; span?: Candidate["span"] }[];
  routingError?: { code: string; capabilities: string[] };
  clarification?: { question: string; options: { label: string; intent: string }[] };
  latencyMs: number;
  stage2: "used" | "skipped";
}
export interface ToolDefinition {
  capability: string;
  toolId: string;
  availability?: () => boolean;
  requiredPermissions?: string[];
  surfaces?: string[];
  local?: boolean;
  cost?: number;
  latencyP95Ms?: number;
  requires?: string[];
  invoke?: (input: Record<string, unknown>) => Promise<unknown>;
}
export class ScoutError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ScoutError";
  }
}
