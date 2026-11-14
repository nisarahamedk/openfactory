#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createBridge } from "./index.js";

/**
 * Local stdio MCP for agents on a laptop (Claude Code, Cursor...), bridged to the factory's own /mcp:
 *   FACTORY_API_URL=https://factory.example FACTORY_API_TOKEN=... FACTORY_ACTOR=<github login> openfactory-mcp
 * Clients that speak Streamable HTTP can use <url>/mcp directly instead.
 */
const env = z
  .object({ FACTORY_API_URL: z.string().url(), FACTORY_API_TOKEN: z.string().min(1), FACTORY_ACTOR: z.string().min(1).optional() })
  .parse(process.env);
const server = createBridge({ url: env.FACTORY_API_URL, token: env.FACTORY_API_TOKEN, actor: env.FACTORY_ACTOR ?? null, version: "0.0.1" });
await server.connect(new StdioServerTransport());
