/**
 * A local stdio bridge to the factory's remote MCP endpoint (/mcp). It holds no tools of its own: it lists and
 * calls whatever the server's capability registry exposes, so the laptop entry can never drift from the server.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface BridgeConfig {
  /** The factory's base URL; tools are served at `<url>/mcp`. */
  url: string;
  /** The API token sent as a bearer token. */
  token: string | null;
  /** Act as this person (`X-Factory-Actor`), so their org role applies; null acts as the key itself. */
  actor: string | null;
  version: string;
}

/** A tool error the model can read, for when the factory can't be reached. */
function unreachable(e: unknown): CallToolResult {
  return { content: [{ type: "text", text: `FACTORY_UNREACHABLE: the factory at the configured URL didn't answer (${String(e)}). Check FACTORY_API_URL and try again.` }], isError: true };
}

/** Build the bridge. `connectRemote` is injectable so tests can point it at an in-memory server. */
export function createBridge(cfg: BridgeConfig, connectRemote: (client: Client) => Promise<void> = (client) => connectHttp(client, cfg)): Server {
  const server = new Server({ name: "openfactory", version: cfg.version }, { capabilities: { tools: {} } });
  let remote: Promise<Client> | null = null;
  const client = (): Promise<Client> => {
    if (remote === null) {
      const c = new Client({ name: "openfactory-bridge", version: cfg.version });
      remote = connectRemote(c).then(() => c);
      // A failed connect is retried on the next call instead of being cached forever.
      remote.catch(() => {
        remote = null;
      });
    }
    return remote;
  };
  server.setRequestHandler(ListToolsRequestSchema, async (req) => (await client()).listTools(req.params));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    let c: Client;
    try {
      c = await client();
    } catch (e) {
      return unreachable(e);
    }
    try {
      return callResult(await c.callTool(req.params));
    } catch (e) {
      return unreachable(e);
    }
  });
  return server;
}

/** The SDK types callTool's result loosely (it allows a legacy shape); the server only ever sends content. */
function callResult(r: Awaited<ReturnType<Client["callTool"]>>): CallToolResult {
  return "content" in r && Array.isArray(r.content) ? { ...r, content: r.content } : { content: [{ type: "text", text: JSON.stringify(r) }] };
}

async function connectHttp(client: Client, cfg: BridgeConfig): Promise<void> {
  const headers: Record<string, string> = {};
  if (cfg.token !== null) headers.authorization = `Bearer ${cfg.token}`;
  if (cfg.actor !== null) headers["x-factory-actor"] = cfg.actor;
  const base = cfg.url.endsWith("/") ? cfg.url.slice(0, -1) : cfg.url;
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
}
