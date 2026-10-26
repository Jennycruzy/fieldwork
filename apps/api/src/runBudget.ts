import type { Budget } from "@fieldwork/llm";
export class RunCallLimit extends Error {
  constructor() {
    super("This run reached its model-call allowance; no further requests were sent.");
    this.name = "RunCallLimit";
  }
}
export function runBudget(daily: Budget) {
  let calls = 0,
    limit = 8;
  const budget: Budget = {
    take: async () => {
      if (calls >= limit) throw new RunCallLimit();
      // Reserve synchronously so two independent requests cannot both spend the final slot.
      calls++;
      try {
        const ok = await daily.take();
        if (!ok) calls--;
        return ok;
      } catch (e) {
        calls--;
        throw e;
      }
    },
    // The daily cap still counts the failed request; only this run's allowance gets the call back.
    release: () => {
      if (calls > 0) calls--;
    },
  };
  return {
    budget,
    get calls() {
      return calls;
    },
    get limit() {
      return limit;
    },
    evaluationRound: (round: number) => {
      limit = 8 + 3 * (Math.max(1, Math.min(3, round)) - 1);
    },
  };
}
