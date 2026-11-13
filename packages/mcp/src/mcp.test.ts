import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FactoryApi } from "@openfactory/client";
import { expect, it } from "vitest";
import { createFactoryMcpServer } from "./index.js";

it("reports an unreachable factory as a tool error, not a crash", async () => {
  const server = createFactoryMcpServer(new FactoryApi({ baseUrl: "http://127.0.0.1:1", token: null }), { version: "t" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  const r = await client.callTool({ name: "list_tasks", arguments: {} });
  expect(r.isError).toBe(true);
  expect(JSON.stringify(r.content)).toContain("unreachable");
});
