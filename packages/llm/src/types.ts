export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  signal?: AbortSignal;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  // Nemotron thinks before answering unless told not to; judging agents keep it, mechanical ones turn it off.
  reasoning?: "on" | "off";
}

export interface ChatResult {
  text: string;
  provider: string;
  modelRequested: string;
  modelServed: string;
  tokensIn: number;
  tokensOut: number;
  ms: number;
}

export interface Provider {
  readonly id: string;
  chat(req: ChatRequest): Promise<ChatResult>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status: number,
    readonly retryable: boolean,
    // false = the provider gave a real answer (a typed refusal); don't try another provider instead.
    readonly fallback = true,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
