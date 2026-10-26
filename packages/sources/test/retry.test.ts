import { afterEach, expect, test, vi } from "vitest";
import { getJson } from "../src/catalogs.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
test("idempotent source reads retry transient transport failure without returning invented data", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("fetch failed"))
    .mockResolvedValueOnce(response({ count: 71 }));
  vi.stubGlobal("fetch", fetcher);
  const result = getJson("https://example.org/query?private_filter=x");
  await vi.runAllTimersAsync();
  expect(await result).toEqual({ count: 71 });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]![1].signal).not.toBe(fetcher.mock.calls[1]![1].signal);
});
test("temporary HTTP errors retry but source refusal and malformed data do not", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response({}, 503))
    .mockResolvedValueOnce(response({}, 429))
    .mockResolvedValueOnce(response({ count: 6 }));
  vi.stubGlobal("fetch", fetcher);
  const result = getJson("https://example.org/data");
  await vi.runAllTimersAsync();
  expect(await result).toEqual({ count: 6 });
  expect(fetcher).toHaveBeenCalledTimes(3);
  fetcher.mockReset().mockResolvedValue(response({}, 400));
  await expect(getJson("https://example.org/data")).rejects.toThrow("HTTP 400");
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockReset().mockResolvedValue(new Response("invalid JSON", { status: 200 }));
  await expect(getJson("https://example.org/data")).rejects.toBeInstanceOf(SyntaxError);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
test("source retries are bounded and final errors identify only the host and transport code", async () => {
  vi.useFakeTimers();
  const failure = new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
  const fetcher = vi.fn().mockRejectedValue(failure);
  vi.stubGlobal("fetch", fetcher);
  const result = getJson("https://example.org/data?private_filter=x").catch((e) => e);
  await vi.runAllTimersAsync();
  const error = await result;
  if (!(error instanceof Error)) throw new Error("Expected a source request error");
  expect(error.message).toContain("example.org");
  expect(error.message).toContain("ECONNRESET");
  expect(error.message).not.toContain("private_filter");
  expect(fetcher).toHaveBeenCalledTimes(3);
});
test("a retry cannot extend the original source request deadline", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
  vi.stubGlobal("fetch", fetcher);
  const start = Date.now(),
    result = getJson("https://example.org/data", 300).catch((e) => e);
  await vi.runAllTimersAsync();
  expect(await result).toBeInstanceOf(Error);
  expect(Date.now() - start).toBeLessThanOrEqual(300);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
