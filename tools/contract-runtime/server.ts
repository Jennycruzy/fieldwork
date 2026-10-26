// CONTRACT TEST SERVER, not Meterless Nightshift. It answers the Meterless Runtime 1.4 provider contract
// (v4) so Fieldwork's provider can be tested without a real runtime, as Meterless's own prompt asks
// ("Build the mock runtime ... first"). Every response carries x-fieldwork-contract-test: true.
// Behaviour is chosen by the requested model id, e.g. "meterless/test.sse".

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const CONTRACT_TOKEN = "contract-test-token";

export function startContractRuntime(port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  let quotaHits = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("x-fieldwork-contract-test", "true");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const authed = req.headers.authorization === `Bearer ${CONTRACT_TOKEN}`;
    const app = req.headers["meterless-app"];
    if (req.url === "/healthz") return json(200, { ok: true });
    if (!authed)
      return json(401, {
        error: { message: "missing or wrong access token", type: "auth", code: "unauthorized" },
      });
    if (app !== "fieldwork")
      return json(400, { error: { message: "meterless-app header required", code: "app_required" } });
    if (req.url === "/v1/models") {
      return json(200, {
        data: [
          { id: "meterless/auto" },
          { id: "meterless/deep" },
          { id: "meterless/text.fast" },
          { id: "meterless/some-future-mode" },
          { id: "other/model" },
        ],
      });
    }
    if (req.url === "/v1/meterless/classes") {
      return json(200, {
        data: [
          { class: "text", state: "ready", chat_carrier: true },
          { class: "vision", state: "parked", chat_carrier: true },
          { class: "mesh", state: "unavailable", why: "no 3D lane seated", chat_carrier: false },
        ],
      });
    }
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      const body = JSON.parse(await read(req)) as { model: string };
      if (req.headers["meterless-scope"] !== "user")
        return json(400, {
          error: { message: "meterless-scope: user required on chat", code: "scope_required" },
        });
      const receipt = { routed_model: "nvidia/nemotron-3.5-lightning-30b-a3b" };
      switch (body.model) {
        case "meterless/test.parts":
          return json(200, {
            choices: [
              {
                message: {
                  content: [
                    { type: "text", text: "part one" },
                    { type: "text", text: "part two" },
                  ],
                },
              },
            ],
            meterless: { receipt },
          });
        case "meterless/test.sse":
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ meterless: { progress: { stage: "loading" } } })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "streamed " } }] })}\n\n`);
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "answer" } }], meterless: { receipt } })}\n\n`,
          );
          return res.end("data: [DONE]\n\n");
        case "meterless/test.quota":
          if (quotaHits++ < 2) return json(429, { error: { message: "busy", code: "rate_limited" } });
          return json(200, { choices: [{ message: { content: "after quota" } }], meterless: { receipt } });
        case "meterless/test.refusal":
          return json(400, {
            error: { message: "This route cannot carry the image class.", code: "class_carrier_unsupported" },
            meterless: { chat_carrier: false, fix: ["Use POST /v1/meterless/jobs for images."] },
          });
        default:
          return json(200, {
            model: body.model,
            choices: [{ message: { content: "plain text answer" } }],
            meterless: { receipt },
          });
      }
    }
    return json(404, { error: { message: "not found", code: "not_found" } });
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    }),
  );
}

function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });
}
