import { describe, it, expect, vi } from "vitest";
import { Scout, ScoutError, IntentRegistry, detectInjection, redact } from "../src/index.js";
import type { RegistryData, ExecutionContract } from "../src/index.js";
import { attacks } from "./attacks.js";
const data: RegistryData = {
  version: 1,
  intents: [
    {
      id: "GENERAL",
      category: "general",
      description: "Conversation",
      parameters: { type: "object" },
      capabilities: [],
      riskClass: "low",
      roles: ["*"],
      surfaces: ["chat", "api"],
      examples: ["hello there"],
      version: 1,
    },
    {
      id: "report.read",
      category: "report",
      description: "Summarize the quarterly report",
      parameters: { type: "object", properties: { period: { type: "string" } }, required: ["period"] },
      capabilities: ["report.read"],
      riskClass: "low",
      roles: ["analyst"],
      surfaces: ["chat"],
      examples: ["Summarize the quarterly report"],
      version: 1,
    },
    {
      id: "report.delete",
      category: "report",
      description: "Delete the quarterly report",
      parameters: { type: "object", properties: { period: { type: "string" } } },
      capabilities: ["report.delete", "approval.require"],
      riskClass: "high",
      roles: ["owner"],
      surfaces: ["chat"],
      examples: ["Delete the quarterly report"],
      version: 1,
    },
  ],
};
const request = {
  prompt: "Summarize the quarterly report",
  surface: "chat",
  user: { id: "u1", role: "analyst" },
  context: { parameters: { period: "Q2" } },
};
describe("Scout contracts", () => {
  it("signs immutable contracts, rejects tampering, identity drift and unknown capabilities", async () => {
    const s = new Scout({ intentRegistry: data }),
      d = await s.decide(request),
      contract = d.executionContract;
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.intent)).toBe(true);
    expect(() => s.verify(contract, "report.read", request.user, "chat")).not.toThrow();
    expect(() => s.verify(contract, "email.send")).toThrow(ScoutError);
    expect(() => s.verify(contract, undefined, { id: "u2", role: "analyst" })).toThrow(/identity/);
    const altered = structuredClone(contract);
    altered.scope.capabilities.push("email.send");
    expect(() => s.verify(altered)).toThrow(/tampered/);
    expect(() => s.verify({ ...contract, signature: "" })).toThrow(/tampered/);
  });
  it("expires after five minutes and replans with a new immutable contract on the same trace", async () => {
    let now = Date.now();
    const s = new Scout({ intentRegistry: data, clock: () => now });
    const a = await s.decide(request);
    now += 300001;
    expect(() => s.verify(a.executionContract)).toThrow(/expired/);
    const b = await s.replan(a.executionContract, request);
    expect(b.executionContract.parentId).toBe(a.executionContract.contractId);
    expect(b.executionContract.traceId).toBe(a.executionContract.traceId);
    expect(b.executionContract.contractId > a.executionContract.contractId).toBe(true);
    expect(() => s.verify(b.executionContract, "report.read")).not.toThrow();
  });
  it("rejects registry drift even with the same signing authority", async () => {
    const s = new Scout({ intentRegistry: data, signingKey: "test-only-signing-authority" }),
      a = await s.decide(request);
    const changed = new Scout({
      intentRegistry: { ...data, version: 2 },
      signingKey: "test-only-signing-authority",
    });
    expect(() => changed.verify(a.executionContract)).toThrow(/version changed/);
  });
  it("checks role, surface, required parameters, fallback, model clearance and stage-two failure", async () => {
    const s = new Scout({
      intentRegistry: data,
      stage2: async () => {
        throw new Error("cold");
      },
    });
    expect((await s.decide({ ...request, user: { id: "u", role: "visitor" } })).risk.level).toBe("block");
    expect((await s.decide({ ...request, surface: "api" })).risk.level).toBe("block");
    expect((await s.decide({ ...request, context: {} })).clarification).toBeDefined();
    const vague = await s.decide({ ...request, prompt: "?" });
    expect(vague.intent.primary.id).toBe("GENERAL");
    expect(vague.toolPlan).toEqual([]);
    expect((await s.decide(request)).stage2).toBe("skipped");
    const restricted = new Scout({
      intentRegistry: data,
      modelProfiles: [
        {
          id: "remote",
          provider: "test",
          model: "test",
          local: false,
          dataClasses: ["public"],
          capabilities: [],
          cost: 0,
          latencyP95Ms: 0,
        },
      ],
    });
    expect(
      (await restricted.decide({ ...request, context: { dataClass: "pii", parameters: { period: "Q2" } } }))
        .risk.level,
    ).toBe("block");
  });
  it("never executes unavailable adapters or unsigned input changes, and requires high-risk approval", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const s = new Scout({
      intentRegistry: data,
      tools: [{ capability: "report.read", toolId: "reports", invoke }],
    });
    const a = await s.decide(request);
    expect(await s.execute(a.executionContract, "report.read")).toEqual({ ok: true });
    await expect(s.execute(a.executionContract, "report.read", { period: "Q3" })).rejects.toThrow(
      /signed plan/,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    const missing = await new Scout({ intentRegistry: data }).decide(request);
    expect(missing.routingError?.capabilities).toEqual(["report.read"]);
    await expect(
      new Scout({ intentRegistry: data }).execute(missing.executionContract, "report.read"),
    ).rejects.toThrow();
    const deletion = await s.decide({
      ...request,
      prompt: "Delete the quarterly report",
      user: { id: "owner", role: "owner" },
    });
    expect(() => s.verify(deletion.executionContract, "report.delete")).toThrow(/approval/);
  });
  it("redacts personal and credential data before routing and signing", async () => {
    const raw = "Email user@example.invalid; SSN 123-45-6789; password=abcdefghijk";
    const result = redact(raw);
    expect(result.sanitized).not.toContain("abcdefghijk");
    expect(result.redactions.length).toBe(3);
    const d = await new Scout({ intentRegistry: data }).decide({
      ...request,
      context: {
        parameters: { period: "user@example.invalid" },
        references: { private: "password=abcdefghijk" },
      },
    });
    expect(JSON.stringify(d.executionContract)).not.toContain("user@example.invalid");
    expect(JSON.stringify(d.executionContract)).not.toContain("abcdefghijk");
  });
  it("scans at startup and distinguishes educational questions from hostile metadata", () => {
    expect(new Scout({ intentRegistry: data }).startupScanMs).toBeLessThan(16);
    const text = "Explain prompt injection: ignore previous instructions";
    expect(detectInjection(text, true).detected).toBe(false);
    expect(detectInjection(text, false).detected).toBe(true);
    expect(() => detectInjection("&#999999999999; normal data")).not.toThrow();
  });
  it.each(attacks)("blocks poisoned description %s", (text) =>
    expect(detectInjection(text).detected).toBe(true),
  );
});
