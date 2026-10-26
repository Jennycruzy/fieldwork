import { expect, test, vi } from "vitest";
import { ModelChain } from "../src/chain.js";
import type { ChatResult } from "../src/types.js";
test("slow model progress stops when the real call finishes", async () => {
  vi.useFakeTimers();
  const onSlow = vi.fn();
  let finish!: (v: ChatResult) => void;
  const chain = new ModelChain(
    [
      {
        provider: {
          id: "test",
          chat: () =>
            new Promise<ChatResult>((r) => {
              finish = r;
            }),
        },
        model: "unit",
      },
    ],
    { onSlow },
  );
  try {
    const result = chain.chat([]);
    await vi.advanceTimersByTimeAsync(30000);
    expect(onSlow).toHaveBeenCalledWith(30);
    finish({
      text: "{}",
      provider: "test",
      modelRequested: "unit",
      modelServed: "unit",
      tokensIn: 0,
      tokensOut: 0,
      ms: 30000,
    });
    await result;
    await vi.advanceTimersByTimeAsync(60000);
    expect(onSlow).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
