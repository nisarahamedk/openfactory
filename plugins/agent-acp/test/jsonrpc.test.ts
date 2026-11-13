import { expect, test } from "vitest";
import { JsonRpcPeer, RpcRequestFailed } from "../src/jsonrpc.js";

test("an error response rejects the request instead of resolving undefined", async () => {
  const toPeer = new TransformStream<Uint8Array, Uint8Array>();
  const fromPeer = new TransformStream<Uint8Array, Uint8Array>();
  const peer = new JsonRpcPeer(fromPeer.writable, toPeer.readable, () => undefined);
  peer.start();
  void fromPeer.readable.pipeTo(new WritableStream());
  const answer = peer.request("session/prompt", {});
  const writer = toPeer.writable.getWriter();
  await writer.write(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "boom" } })}\n`));
  await expect(answer).rejects.toBeInstanceOf(RpcRequestFailed);
  await expect(answer).rejects.toThrow(/boom/);
});
