#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FactoryApi } from "@openfactory/client";
import { createFactoryMcpServer } from "./index.js";

/**
 * Local stdio MCP server for agents on a laptop (Claude Code, Cursor...):
 *   FACTORY_API_URL=https://factory.<ip>.sslip.io FACTORY_API_TOKEN=... openfactory-mcp
 * Remote clients can use the server's own /mcp endpoint instead.
 */
const env = z.object({ FACTORY_API_URL: z.string().url(), FACTORY_API_TOKEN: z.string().min(1) }).parse(process.env);
const server = createFactoryMcpServer(new FactoryApi({ baseUrl: env.FACTORY_API_URL, token: env.FACTORY_API_TOKEN }), { version: "0.0.1" });
await server.connect(new StdioServerTransport());
