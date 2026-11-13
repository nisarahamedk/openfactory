/**
 * A small JSON-RPC 2.0 peer over newline-delimited JSON, which is how ACP
 * agents talk on stdio. We keep our own instead of the ACP SDK's connection
 * classes: the SDK's API changed shape twice in 2026, and the factory only needs
 * a handful of methods. The wire format is the stable part.
 */
import { z } from "zod";

const RpcId = z.union([z.string(), z.number()]);

const RpcError = z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() });

// Order matters: an error response must not be read as a success, and
// `z.unknown()` would accept a missing `result`.
const IncomingMessage = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: RpcId, method: z.string(), params: z.unknown().optional() }),
  z.object({ jsonrpc: z.literal("2.0"), method: z.string(), params: z.unknown().optional() }),
  z.object({ jsonrpc: z.literal("2.0"), id: RpcId.nullable(), error: RpcError }),
  z.object({ jsonrpc: z.literal("2.0"), id: RpcId, result: z.unknown() }).refine((m) => "result" in m),
]);

/** The other side answered a request with a JSON-RPC error. */
export class RpcRequestFailed extends Error {
  readonly code = "rpc_request_failed" as const;
  constructor(
    readonly method: string,
    readonly rpcCode: number,
    rpcMessage: string,
    readonly data: unknown,
  ) {
    super(`ACP request ${method} failed (${rpcCode}): ${rpcMessage}`);
  }
}

/** The connection closed while a request was waiting for its answer. */
export class RpcConnectionClosed extends Error {
  readonly code = "rpc_connection_closed" as const;
  constructor(readonly method: string, reason: string) {
    super(`ACP connection closed while waiting for ${method}: ${reason}`);
  }
}

export type RequestHandler = (params: unknown) => Promise<unknown>;
export type NotificationHandler = (params: unknown) => void;

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** One JSON-RPC connection. Call `start()` once, after registering handlers. */
export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly encoder = new TextEncoder();
  private closedReason: string | null = null;
  /** Resolves when the input stream ends or fails. */
  readonly closed: Promise<string>;
  private resolveClosed: (reason: string) => void = () => undefined;

  constructor(
    output: WritableStream<Uint8Array>,
    private readonly input: ReadableStream<Uint8Array>,
    private readonly onProtocolNoise: (line: string) => void,
  ) {
    this.writer = output.getWriter();
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  start(): void {
    void this.readLoop();
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.closedReason !== null) throw new RpcConnectionClosed(method, this.closedReason);
    const id = this.nextId++;
    const answer = new Promise<unknown>((resolve, reject) => {
      this.pending.set(String(id), { method, resolve, reject });
    });
    await this.send({ jsonrpc: "2.0", id, method, params });
    return answer;
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.send({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    await this.writer.close().catch((error: unknown) => {
      // Closing an already-broken pipe is the expected way this fails; record it.
      this.onProtocolNoise(`close: ${String(error)}`);
    });
  }

  private async send(message: unknown): Promise<void> {
    await this.writer.write(this.encoder.encode(`${JSON.stringify(message)}\n`));
  }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    const reader = this.input.getReader();
    let buffer = "";
    let reason = "agent output ended";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) this.handleLine(line);
          newline = buffer.indexOf("\n");
        }
      }
    } catch (error) {
      reason = `agent output failed: ${String(error)}`;
    }
    this.closedReason = reason;
    for (const pending of this.pending.values()) pending.reject(new RpcConnectionClosed(pending.method, reason));
    this.pending.clear();
    this.resolveClosed(reason);
  }

  private handleLine(line: string): void {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      // Agents sometimes print logs on stdout; they are not protocol messages.
      this.onProtocolNoise(line);
      return;
    }
    const parsed = IncomingMessage.safeParse(json);
    if (!parsed.success) {
      this.onProtocolNoise(line);
      return;
    }
    const message = parsed.data;
    if ("method" in message) {
      if ("id" in message) void this.answerRequest(message.id, message.method, message.params);
      else this.notificationHandlers.get(message.method)?.(message.params);
      return;
    }
    if (message.id === null) {
      this.onProtocolNoise(line);
      return;
    }
    const pending = this.pending.get(String(message.id));
    if (pending === undefined) {
      this.onProtocolNoise(line);
      return;
    }
    this.pending.delete(String(message.id));
    if ("error" in message) {
      pending.reject(new RpcRequestFailed(pending.method, message.error.code, message.error.message, message.error.data));
    } else {
      pending.resolve(message.result);
    }
  }

  private async answerRequest(id: string | number, method: string, params: unknown): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (handler === undefined) {
      await this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    try {
      const result = await handler(params);
      await this.send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      await this.send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(error) } });
    }
  }
}
