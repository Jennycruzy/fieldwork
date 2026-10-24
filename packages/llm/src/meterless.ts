// Meterless Runtime as an OpenAI-compatible provider (Meterless Runtime 1.4, provider contract v4,
// from the POWER prompts on meterless.ai/engines.html). Nightshift serves this API on the machine it runs on.

import { ProviderError, type ChatRequest, type ChatResult, type Provider } from "./types.js";

export const METERLESS_DEFAULT_BASE = "http://127.0.0.1:8088/v1";
export const METERLESS_APP = "fieldwork";
const TIMEOUT_MS = 180_000; // a model load can take minutes

// Accept a pasted URL with or without a scheme, /v1, /v1/chat/completions, /v1/models or /healthz; never /v1/v1.
export function normaliseBaseUrl(input: string): string {
  let s = input.trim();
  if (!s) return METERLESS_DEFAULT_BASE;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);
  return `${u.protocol}//${u.host}/v1`;
}

// http://<host>:<port>/connect#k=<key> -> base URL and token. The link itself is never logged.
export function parseConnectLink(input: string): { baseUrl: string; token: string } | undefined {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (!/\/connect\/?$/.test(u.pathname)) return undefined;
  const k = new URLSearchParams(u.hash.replace(/^#/, "")).get("k");
  if (!k) return undefined;
  return { baseUrl: `${u.protocol}//${u.host}/v1`, token: k };
}

export type RuntimeState = "online" | "unauthorized" | "offline";

export interface RuntimeStatus {
  state: RuntimeState;
  baseUrl: string;
  checkedAt: string;
  reason: string;
  modes: string[]; // meterless/* routing modes, unknown ones kept
}

export type ClassState = "ready" | "may take a moment" | "leaves the machine" | "unavailable";

export interface RuntimeClass {
  id: string;
  state: ClassState;
  why?: string;
  chatCarrier?: boolean;
}

export class MeterlessError extends ProviderError {
  constructor(
    message: string,
    status: number,
    retryable: boolean,
    readonly code?: string,
    readonly fix?: string[],
    readonly chatCarrier?: boolean,
    // Only a transport failure may fall back to a cloud provider; a typed refusal goes back to the caller.
    fallback = true,
  ) {
    super(message, "meterless", status, retryable, fallback);
    this.name = "MeterlessError";
  }
}

export class MeterlessProvider implements Provider {
  readonly id = "meterless";
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string | undefined,
    private readonly opts: { sleep?: (ms: number) => Promise<void>; timeoutMs?: number } = {},
  ) {
    this.baseUrl = normaliseBaseUrl(baseUrl);
    if (token === "rt-local") throw new Error("rt-local is a placeholder; paste the runtime's real access token");
  }

  private headers(chat = false): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      "meterless-app": METERLESS_APP,
      ...(chat ? { "meterless-scope": "user" } : {}),
    };
  }

  // GET /v1/models decides the state; /healthz only proves the process is up.
  async status(): Promise<RuntimeStatus> {
    const checkedAt = new Date().toISOString();
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(5000) });
      if (res.status === 401 || res.status === 403) {
        return { state: "unauthorized", baseUrl: this.baseUrl, checkedAt, reason: "The runtime refused the access token. Paste the runtime's access token in Settings.", modes: [] };
      }
      if (res.status !== 200) return { state: "offline", baseUrl: this.baseUrl, checkedAt, reason: `The runtime answered HTTP ${res.status}`, modes: [] };
      const body = (await res.json()) as { data?: { id?: string }[] };
      const modes = (body.data ?? []).map((m) => m.id ?? "").filter((id) => id.startsWith("meterless/"));
      if (modes.length === 0) return { state: "offline", baseUrl: this.baseUrl, checkedAt, reason: "No meterless/* routing modes listed", modes };
      return { state: "online", baseUrl: this.baseUrl, checkedAt, reason: `${modes.length} routing modes`, modes };
    } catch {
      return { state: "offline", baseUrl: this.baseUrl, checkedAt, reason: `Meterless Runtime isn't reachable at ${this.baseUrl}. Start the runtime and run Auto Detect.`, modes: [] };
    }
  }

  // GET /v1/meterless/classes, in either shape; a runtime without the route still gets a working picker.
  async classes(): Promise<RuntimeClass[]> {
    const res = await fetch(`${this.baseUrl}/meterless/classes`, { headers: this.headers(), signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { classes?: Record<string, unknown>; data?: unknown[] };
    const rows: { id: string; raw: unknown }[] = body.classes
      ? Object.entries(body.classes).map(([id, raw]) => ({ id, raw }))
      : (body.data ?? []).map((raw) => ({ id: String((raw as { class?: string }).class ?? ""), raw }));
    return rows.filter((r) => r.id).map(({ id, raw }) => {
      const o = typeof raw === "string" ? { state: raw } : (raw as { state?: string; why?: string; reason?: string; chat_carrier?: boolean });
      return { id, state: mapState(o.state), why: o.why ?? o.reason, chatCarrier: o.chat_carrier };
    });
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const started = Date.now();
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const quotaWaits = [2000, 4000, 8000];
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: this.headers(true),
          body: JSON.stringify({ model: req.model, messages: req.messages, max_tokens: req.maxTokens ?? 2000, temperature: req.temperature ?? 0, stream: false }),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? TIMEOUT_MS),
        });
      } catch {
        throw new MeterlessError(`Meterless Runtime isn't reachable at ${this.baseUrl}. Start the runtime and run Auto Detect.`, 0, true);
      }
      if (res.status === 429) {
        const err = await errorFrom(res, this.baseUrl);
        if (err.code === "auth_rate_limited") throw err; // repeated bad keys: ask for the key, don't retry
        const wait = quotaWaits[attempt];
        if (wait === undefined) throw err;
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw await errorFrom(res, this.baseUrl);
      const type = res.headers.get("content-type") ?? "";
      const { text, served } = type.includes("text/event-stream") ? await readSse(res) : readJson(await res.json());
      if (!text.trim()) throw new MeterlessError("Meterless Runtime returned an empty answer", 204, true);
      return { text, provider: this.id, modelRequested: req.model, modelServed: served ?? req.model, tokensIn: 0, tokensOut: 0, ms: Date.now() - started };
    }
  }
}

function mapState(s?: string): ClassState {
  if (s === "ready") return "ready";
  if (s === "cloud") return "leaves the machine";
  if (s && ["starting", "parked", "declared", "admittable"].includes(s)) return "may take a moment";
  return "unavailable";
}

interface Answer {
  model?: string;
  choices?: { message?: { content?: unknown }; delta?: { content?: unknown } }[];
  meterless?: { routed_model?: string; receipt?: { routed_model?: string } };
}

// content as a string, or as an array of parts (text parts joined; other parts named on their own lines).
export function readJson(body: Answer): { text: string; served?: string } {
  const content = body.choices?.[0]?.message?.content;
  return { text: flatten(content), served: body.meterless?.receipt?.routed_model ?? body.meterless?.routed_model ?? body.model };
}

function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p: { type?: string; text?: string; image_url?: { url?: string }; audio_url?: { url?: string } }) =>
      p.type === "text" ? (p.text ?? "") : p.image_url?.url ? `Image: ${p.image_url.url}` : p.audio_url?.url ? `Audio: ${p.audio_url.url}` : "",
    )
    .filter(Boolean)
    .join("\n");
}

async function readSse(res: Response): Promise<{ text: string; served?: string }> {
  const raw = await res.text();
  let text = "";
  let served: string | undefined;
  for (const line of raw.split("\n")) {
    const m = line.match(/^data:\s*(.*)$/);
    if (!m || m[1] === "[DONE]") continue;
    try {
      const frame = JSON.parse(m[1]!) as Answer;
      text += flatten(frame.choices?.[0]?.delta?.content);
      served = frame.meterless?.receipt?.routed_model ?? frame.meterless?.routed_model ?? frame.model ?? served;
    } catch {
      // progress frames and comments carry no text
    }
  }
  return { text, served };
}

const HINTS: Record<string, string> = {
  model_not_found: "Pick a meterless/* routing mode the runtime lists.",
  class_no_route: "No seated lane can serve this request right now.",
};

// Message order: server message; server fix[] (wins); our hint only if no fix and not a carrier refusal; auth line.
async function errorFrom(res: Response, _base: string): Promise<MeterlessError> {
  let msg = `Meterless Runtime HTTP ${res.status}`;
  let code: string | undefined;
  let fix: string[] | undefined;
  let carrier: boolean | undefined;
  try {
    const b = (await res.json()) as { error?: { message?: string; code?: string; type?: string }; meterless?: { fix?: string[]; chat_carrier?: boolean } };
    msg = b.error?.message ?? msg;
    code = b.error?.code;
    fix = b.meterless?.fix;
    carrier = b.meterless?.chat_carrier;
  } catch {
    // non-JSON error body
  }
  const carrierRefusal = code === "class_carrier_unsupported" || carrier === false;
  const hint = code ? HINTS[code] : undefined;
  const parts = [msg];
  if (fix?.length) parts.push(...fix);
  else if (hint && !carrierRefusal) parts.push(hint);
  if (res.status === 401 || res.status === 403) parts.push("Paste the runtime's access token in Settings.");
  // A typed refusal (any error with a code) is the runtime's answer: don't hide it behind a cloud fallback.
  return new MeterlessError(parts.join(" "), res.status, false, code, fix, carrier, !code && res.status >= 500);
}

// Tries the runtime's usual ports on the loopback names; the first online or unauthorized hit wins.
export async function autoDetect(token: string | undefined): Promise<RuntimeStatus | undefined> {
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    for (const port of [8088, 8090, 8787, 11434]) {
      const s = await new MeterlessProvider(`http://${host}:${port}`, token).status();
      if (s.state === "online" || s.state === "unauthorized") return s;
    }
  }
  return undefined;
}
