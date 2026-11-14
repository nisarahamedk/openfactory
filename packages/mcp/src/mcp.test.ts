import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, it } from "vitest";
import { z } from "zod";
import { createBridge } from "./index.js";

const cfg = { url: "http://127.0.0.1:1", token: null, actor: null, version: "t" };

async function local(bridge: ReturnType<typeof createBridge>): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await bridge.connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  return client;
}

it("lists and calls the remote server's tools", async () => {
  const remote = new McpServer({ name: "factory", version: "t" });
  remote.registerTool("list_tasks", { description: "List tasks", inputSchema: { status: z.string().optional() } }, async (args) => ({ content: [{ type: "text", text: `tasks ${args.status ?? "all"}` }] }));
  const client = await local(
    createBridge(cfg, async (c) => {
      const [a, b] = InMemoryTransport.createLinkedPair();
      await remote.connect(a);
      await c.connect(b);
    }),
  );
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["list_tasks"]);
  expect(JSON.stringify((await client.callTool({ name: "list_tasks", arguments: { status: "open" } })).content)).toContain("tasks open");
});

it("reports an unreachable factory as a tool error, not a crash", async () => {
  const client = await local(createBridge(cfg));
  const r = await client.callTool({ name: "list_tasks", arguments: {} });
  expect(r.isError).toBe(true);
  expect(JSON.stringify(r.content)).toContain("FACTORY_UNREACHABLE");
});
