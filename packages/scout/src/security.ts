import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { ScoutError, type ExecutionContract, type Risk } from "./types.js";
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const object = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(object)
      .filter((k) => object[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(object[k]))
      .join(",") +
    "}"
  );
}
export function signContract(
  contract: Omit<ExecutionContract, "signature">,
  key: Uint8Array | string,
): string {
  return createHmac("sha256", key).update(canonical(contract)).digest("hex");
}
export function verifySignature(contract: ExecutionContract, key: Uint8Array | string) {
  const { signature, ...unsigned } = contract,
    expected = signContract(unsigned, key);
  return (
    typeof signature === "string" &&
    /^[a-f0-9]{64}$/.test(signature) &&
    timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))
  );
}
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const encoded = (value: bigint, length: number) => {
  let out = "";
  for (let i = 0; i < length; i++) {
    out = alphabet[Number(value % 32n)] + out;
    value /= 32n;
  }
  return out;
};
export class MonotonicId {
  private time = -1;
  private randomness = 0n;
  next(now: number) {
    if (now > this.time) {
      this.time = now;
      this.randomness = BigInt("0x" + randomBytes(10).toString("hex"));
    } else this.randomness++;
    return encoded(BigInt(this.time), 10) + encoded(this.randomness, 16);
  }
}
export function redact(text: string) {
  const patterns: [string, RegExp][] = [
    [
      "credential",
      /\b(?:sk-[a-zA-Z0-9_-]{16,}|(?:api[_ -]?key|password|bearer\s+token)\s*[:=]\s*["']?[a-zA-Z0-9_./+-]{8,})/gi,
    ],
    ["email", /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g],
    ["ssn", /\b\d{3}-\d{2}-\d{4}\b/g],
    ["phone", /(?<!\d)(?:\+1[ -]?)?\(?\d{3}\)?[ -]\d{3}[ -]\d{4}(?!\d)/g],
    ["card", /\b(?:\d[ -]?){15,16}\b/g],
  ];
  const spans: Risk["redactions"] = [];
  for (const [kind, pattern] of patterns)
    for (const match of text.matchAll(pattern))
      spans.push({ kind, start: match.index!, end: match.index! + match[0].length });
  const selected = spans
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .filter((s, i, a) => !a.slice(0, i).some((p) => p.start <= s.start && p.end >= s.end));
  let sanitized = text;
  for (const s of [...selected].sort((a, b) => b.start - a.start))
    sanitized =
      sanitized.slice(0, s.start) + "[REDACTED_" + s.kind.toUpperCase() + "]" + sanitized.slice(s.end);
  return { sanitized, redactions: selected };
}
const patterns: [string, RegExp][] = [
  [
    "privilege-escalation",
    /\b(?:grant|give|make|elevate|escalate)\b[\s\S]{0,65}\b(?:admin|administrator|root|superuser|privileges|permissions)\b|\b(?:use|invoke|open|call)\s+(?:internal[_-])?(?:admin|root)[\w.-]*/i,
  ],
  [
    "reversed-override",
    /\b(?:ignore|disregard|override|forget|bypass)\s+(?:all\s+|the\s+)?(?:rules?|instructions?|policies|guards?)\s+(?:above|earlier|previously|before)\b|\byou are now in\s+(?:unrestricted|unfiltered|developer|god)\s+mode\b/i,
  ],
  [
    "instruction-override",
    /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|the\s+|any\s+)?(?:previous|prior|earlier|above|system|developer|safety|security)\s*(?:instructions?|rules?|prompts?|polic(?:y|ies)|checks?|filters?|guards?)?/i,
  ],
  [
    "role-control",
    /<\/?(?:system|developer|assistant)\b|\[\/?INST\]|<<\/?SYS>>|<\|(?:im_start|im_end|system|assistant)\|>|(?:^|\n)\s*(?:SYSTEM|DEVELOPER)\s*:/i,
  ],
  [
    "role-drift",
    /\b(?:you are now|pretend to be|act as|assume the role of)\s+(?:an?\s+|the\s+)?(?:system|developer|root|administrator|unrestricted|unfiltered|DAN)\b/i,
  ],
  [
    "secret-exfiltration",
    /\b(?:send|post|upload|exfiltrate|forward|print|reveal|expose|show)\b[\s\S]{0,100}\b(?:api[_ -]?keys?|credentials?|passwords?|secrets?|system prompt|environment variables?|access tokens?)\b/i,
  ],
  [
    "data-exfiltration",
    /\b(?:send|post|upload|forward)\b[\s\S]{0,80}\b(?:rows|results|data|response|contents)\b[\s\S]{0,80}https?:\/\//i,
  ],
  [
    "tool-reference",
    /\b(?:call|invoke|execute|use)\s+(?:the\s+)?(?:tool\.|functions\.|mcp\.)[a-z_.]+|\b(?:run|execute)\s+(?:sudo|bash|shell|rm\s+-rf|curl\s+[^ ]+\s+-d)\b/i,
  ],
  [
    "fabricated-values",
    /\b(?:invent|fabricate|falsify)\b[\s\S]{0,70}\b(?:numbers?|figures?|results?|statistics?|data)\b|\b(?:set|replace|override)\s+(?:the\s+)?(?:count|rate|value|total|score|answer|result|population)[\w ]{0,30}\s(?:to|with|=)\s*\d|\b(?:always|must)\s+(?:report|claim|answer|return)\b[\s\S]{0,70}\b(?:regardless|unverified|fake|without checking)\b/i,
  ],
];
function normalized(text: string) {
  let value = text
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, "")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_m, h, d) =>
      String.fromCodePoint(Math.min(0x10ffff, parseInt(h ?? d, h ? 16 : 10))),
    );
  try {
    if (/%[0-9a-f]{2}/i.test(value)) value = decodeURIComponent(value);
  } catch {
    /* Invalid URL encoding remains literal data. */
  }
  return value;
}
export function detectInjection(text: string, allowEducational = false) {
  const clipped = text.slice(0, 100000);
  const input = normalized(clipped) + "\n" + normalized(clipped.replace(/[\u200b-\u200f\u2060\ufeff]/g, " ")),
    evidence: string[] = text.length > 100000 ? ["oversized-input"] : [];
  const educational =
    /^\s*(?:explain|describe|discuss|what is|how does)\b/i.test(input) &&
    /\b(?:prompt injection|attack|security|instruction override)\b/i.test(input) &&
    !/\b(?:then|also)\s+(?:execute|follow|obey|send|reveal)\b/i.test(input);
  for (const [kind, re] of patterns) {
    const match = re.exec(input);
    if (!match) continue;
    if (
      kind === "instruction-override" &&
      /\b(?:do not|don't|never)\s*$/i.test(input.slice(Math.max(0, match.index - 15), match.index))
    )
      continue;
    if (educational && allowEducational) continue;
    evidence.push(kind);
  }
  for (const match of input.matchAll(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g)) {
    const decoded = Buffer.from(match[0], "base64").toString("utf8");
    if (patterns.some(([, re]) => re.test(decoded))) evidence.push("encoded-instructions");
  }
  return {
    detected: evidence.length > 0,
    kind: evidence[0] ?? "none",
    score: evidence.length ? Math.min(1, 0.9 + evidence.length * 0.02) : 0,
    evidence: [...new Set(evidence)],
    payload_sha256: createHash("sha256").update(text).digest("hex"),
  };
}
export function assertContract(
  contract: ExecutionContract,
  key: Uint8Array | string,
  now: number,
  registryVersion: number,
  capability?: string,
) {
  if (contract.signedBy !== "scout" || !verifySignature(contract, key))
    throw new ScoutError("Unsigned or tampered execution contract", "INVALID_SIGNATURE");
  const issued = Date.parse(contract.issuedAt),
    expires = Date.parse(contract.expiresAt);
  if (
    !Number.isFinite(expires) ||
    !Number.isFinite(issued) ||
    expires - issued > 300000 ||
    expires <= issued ||
    issued > now + 1000 ||
    now >= expires
  )
    throw new ScoutError("Execution contract expired or has an invalid lifetime", "EXPIRED_CONTRACT");
  if (contract.registryVersion !== registryVersion)
    throw new ScoutError("Intent registry version changed", "REGISTRY_DRIFT");
  if (contract.risk.level === "block")
    throw new ScoutError(contract.risk.reason ?? "Execution is blocked", "BLOCKED_CONTRACT");
  if (
    contract.risk.approvalsRequired?.length &&
    !contract.risk.approvalsRequired.every((kind) =>
      contract.risk.approvals.some((a) => a.kind === kind && a.decision === "approve"),
    )
  )
    throw new ScoutError("Required approval is missing", "APPROVAL_REQUIRED");
  if (capability && !contract.scope.capabilities.includes(capability))
    throw new ScoutError("Capability is outside this contract's scope", "SCOPE_MISMATCH");
}
