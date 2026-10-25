// One place every agent's model call goes through: providers in priority order, retries with backoff,
// a fallback model per role, a daily call budget, and a record of which model actually answered.

import { z } from "zod";
import { ProviderError, type ChatMessage, type ChatResult, type Provider } from "./types.js";

export interface Route {
  provider: Provider;
  model: string;
}

export interface CallRecord extends ChatResult {
  attempt: number;
  ok: boolean;
  error?: string;
}

export interface Budget {
  // Returns false when the day's calls are used up.
  take(): Promise<boolean>;
}

export const unlimited: Budget = { take: async () => true };

export class BudgetExceeded extends Error {
  constructor() {
    super("Today's model calls are used up");
    this.name = "BudgetExceeded";
  }
}

export interface ChainOptions {
  budget?: Budget;
  reasoning?: "on" | "off";
  backoffMs?: number[];
  onSlow?: (seconds: number) => void;
  onCall?: (rec: CallRecord) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ModelChain {
  private readonly backoff: number[];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly routes: Route[],
    private readonly opts: ChainOptions = {},
  ) {
    if (routes.length === 0) throw new Error("no model routes configured");
    this.backoff = opts.backoffMs ?? [2000, 6000, 18000];
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async chat(messages: ChatMessage[], maxTokens = 2000, startAt=0, once=false): Promise<ChatResult> {
    let lastError: unknown;
    let attempt = 0;
    for (const route of this.routes.slice(startAt,once?startAt+1:undefined)) {
      for (let i = 0; i <= this.backoff.length; i++) {
        attempt++;
        if (!(await (this.opts.budget ?? unlimited).take())) throw new BudgetExceeded();
        const started = Date.now();
        try {
          const timer = setInterval(() => this.opts.onSlow?.(Math.round((Date.now() - started) / 1000)), 30000);
          let res: ChatResult;
          try { res = await route.provider.chat({ model: route.model, messages, maxTokens, reasoning: this.opts.reasoning }); }
          finally { clearInterval(timer); }
          await this.opts.onCall?.({ ...res, attempt, ok: true });
          return res;
        } catch (e) {
          lastError = e;
          const err = e instanceof ProviderError ? e : undefined;
          await this.opts.onCall?.({
            text: "",
            provider: route.provider.id,
            modelRequested: route.model,
            modelServed: route.model,
            tokensIn: 0,
            tokensOut: 0,
            ms: Date.now()-started,
            attempt,
            ok: false,
            error: (e as Error).message.slice(0, 300),
          });
          if (err && !err.fallback) throw err; // a typed refusal goes back to the caller with its real reason
          if (!err?.retryable) break; // not worth retrying this route; try the next one
          if ((err.status === 204 || err.status === 502) && i >= 1) break; // empty twice: switch model rather than wait
          const wait = this.backoff[i];
          if (wait === undefined) break;
          await this.sleep(wait);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("all model routes failed");
  }

  // Ask for JSON matching a schema. One repair attempt if the first answer doesn't parse.
  async json<T>(messages: ChatMessage[], schema: z.ZodType<T>, maxTokens = 2000): Promise<{ value: T; calls: ChatResult[] }> {
    const calls: ChatResult[] = [];
    const first = await this.chat(messages, maxTokens);
    calls.push(first);
    const parsed = parseJson(first.text, schema);
    if (parsed.ok) return { value: parsed.value, calls };
    const repair = await this.chat(
      [
        ...messages,
        { role: "assistant", content: first.text },
        { role: "user", content: `That was not valid JSON for the required shape (${parsed.error}). Reply with the JSON only.` },
      ],
      maxTokens,
    );
    calls.push(repair);
    const again = parseJson(repair.text, schema);
    if (again.ok) return { value: again.value, calls };
    const used=this.routes.findIndex(r=>r.provider.id===repair.provider&&r.model===repair.modelRequested);
    if(used>=0&&used+1<this.routes.length) {
      const fallback=await this.chat(messages,maxTokens,used+1,true);calls.push(fallback);
      const parsedFallback=parseJson(fallback.text,schema);
      if(parsedFallback.ok)return {value:parsedFallback.value,calls};
      throw new Error(`model did not return valid JSON: ${parsedFallback.error}`);
    }
    throw new Error(`model did not return valid JSON: ${again.error}`);
  }
}

export function parseJson<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "");
  let error="no schema-matching JSON object found";
  for(let start=0;start<cleaned.length;start++) {
    if(cleaned[start]!=="{")continue;
    let depth=0,quoted=false,escaped=false;
    for(let end=start;end<cleaned.length;end++) {
      const c=cleaned[end];
      if(quoted) {
        if(escaped)escaped=false;
        else if(c==="\\")escaped=true;
        else if(c==='"')quoted=false;
        continue;
      }
      if(c==='"'){quoted=true;continue;}
      if(c==="{")depth++;
      if(c!=="}"||--depth!==0)continue;
      try {
        const value=JSON.parse(cleaned.slice(start,end+1));
        const result=schema.safeParse(value);
        if(result.success)return {ok:true,value:result.data};
        error=result.error.issues.map(i=>`${i.path.join(".")}: ${i.message}`).join("; ");
      } catch(e){error=`JSON parse error: ${(e as Error).message}`;}
      break;
    }
  }
  return {ok:false,error};
}
