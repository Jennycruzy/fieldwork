import { ProviderError, type ChatRequest, type ChatResult, type Provider } from "./types.js";

export class OpenRouterProvider implements Provider {
  readonly id = "openrouter";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://openrouter.ai/api/v1",
    private readonly timeoutMs = 180_000,
  ) {}

  async chat(req: ChatRequest): Promise<ChatResult> {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/Jennycruzy/fieldwork",
          "X-Title": "Fieldwork",
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          max_tokens: req.maxTokens ?? 2000,
          temperature: req.temperature ?? 0,
          ...(req.reasoning === "off" ? { reasoning: { enabled: false } } : {}),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new ProviderError(`OpenRouter did not answer: ${(e as Error).message}`, this.id, 0, true);
    }
    const text = await res.text();
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new ProviderError(`OpenRouter HTTP ${res.status}: ${text.slice(0, 200)}`, this.id, res.status, retryable);
    }
    const body = JSON.parse(text) as {
      model?: string;
      choices?: { finish_reason?: string; message?: { content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string; code?: number };
    };
    if (body.error) {
      throw new ProviderError(`OpenRouter error: ${body.error.message ?? "unknown"}`, this.id, body.error.code ?? 0, true);
    }
    const content = body.choices?.[0]?.message?.content ?? "";
    if (!content.trim()) {
      const why = body.choices?.[0]?.finish_reason === "length" ? " (it used its whole budget thinking)" : "";
      throw new ProviderError(`OpenRouter returned an empty answer${why}`, this.id, 204, true);
    }
    return {
      text: content,
      provider: this.id,
      modelRequested: req.model,
      modelServed: body.model ?? req.model,
      tokensIn: body.usage?.prompt_tokens ?? 0,
      tokensOut: body.usage?.completion_tokens ?? 0,
      ms: Date.now() - started,
    };
  }
}
