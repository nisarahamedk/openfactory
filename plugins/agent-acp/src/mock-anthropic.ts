/**
 * A scripted stand-in for the Anthropic Messages API, so agent harnesses can be
 * tested end to end without spending money. Point the agent's
 * ANTHROPIC_BASE_URL at it. Each request is matched against the rules in order;
 * the first rule that returns a reply wins. Only requests that offer tools (the
 * agent's main loop) reach the rules; side calls (titles, memory picks) and
 * unmatched requests get a short text reply.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type MockBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> };

export interface MockRequest {
  model: string;
  system: string;
  messages: Array<{ role: string; content: unknown }>;
  stream: boolean;
  /** Every text in the conversation, joined, for easy matching. */
  transcript: string;
  /** True when the newest user message carries tool results. */
  lastIsToolResult: boolean;
  /** Text of the newest user message. */
  lastUserText: string;
  /** True for the agent's main loop (it offers tools); false for side calls such as titles. */
  hasTools: boolean;
}

export type MockRule = (req: MockRequest) => MockBlock[] | null;

export interface MockAnthropic {
  url: string;
  /** Every /v1/messages request seen, newest last. */
  requests: MockRequest[];
  close(): Promise<void>;
}

export async function startMockAnthropic(rules: MockRule[], port = 0, host = "127.0.0.1"): Promise<MockAnthropic> {
  const requests: MockRequest[] = [];
  let toolSeq = 0;
  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: String(error) } }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (req.method === "POST" && path.endsWith("/v1/messages/count_tokens")) {
      return json(res, { input_tokens: 100 });
    }
    if (req.method === "GET" && path.endsWith("/v1/models")) {
      return json(res, { data: [], has_more: false });
    }
    if (req.method !== "POST" || !path.endsWith("/v1/messages")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const parsed = toMockRequest(JSON.parse(body) as Record<string, unknown>);
    requests.push(parsed);
    const scripted = parsed.hasTools ? rules.map((rule) => rule(parsed)).find((r) => r !== null) : undefined;
    const blocks = scripted ?? [{ type: "text", text: "ok" }];
    type WireBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
    const content: WireBlock[] = blocks.map((b): WireBlock =>
      b.type === "text" ? b : { type: "tool_use", id: `toolu_mock_${++toolSeq}`, name: b.name, input: b.input },
    );
    const stopReason = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
    const usage = { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const message = { id: `msg_mock_${requests.length}`, type: "message", role: "assistant", model: parsed.model };
    if (!parsed.stream) {
      return json(res, { ...message, content, stop_reason: stopReason, stop_sequence: null, usage });
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send("message_start", {
      type: "message_start",
      message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } },
    });
    content.forEach((block, index) => {
      if (block.type === "text") {
        send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
        send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
      } else {
        send("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
        });
        send("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        });
      }
      send("content_block_stop", { type: "content_block_stop", index });
    });
    send("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    });
    send("message_stop", { type: "message_stop" });
    res.end();
  }

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://${host}:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function toMockRequest(body: Record<string, unknown>): MockRequest {
  const messages = (body.messages as MockRequest["messages"] | undefined) ?? [];
  const system = textOf(body.system);
  const userMessages = messages.filter((m) => m.role === "user");
  const last = userMessages[userMessages.length - 1];
  const lastBlocks = Array.isArray(last?.content) ? (last.content as Array<{ type?: string }>) : [];
  return {
    model: typeof body.model === "string" ? body.model : "mock",
    system,
    messages,
    stream: body.stream === true,
    transcript: messages.map((m) => textOf(m.content)).join("\n"),
    lastIsToolResult: last?.role === "user" && lastBlocks.some((b) => b.type === "tool_result"),
    lastUserText: last === undefined ? "" : textOf(last.content),
    hasTools: Array.isArray(body.tools) && body.tools.length > 0,
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => {
      if (typeof block !== "object" || block === null) return "";
      const b = block as { type?: string; text?: unknown; content?: unknown };
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (b.type === "tool_result") return textOf(b.content);
      return "";
    })
    .join("\n");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}
