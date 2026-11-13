import { defineProvider } from "@openfactory/contracts";
import { fromEnv } from "./claude-code.js";
import { envWithOptions } from "./options.js";

/**
 * factory.yaml: `agent: { acp: { agent: claude-code, model: claude-sonnet-4-5, modelProxyUrl: http://litellm:4000 } }`.
 * Each option falls back to its env var (WORKER_MODEL, MODEL_PROXY_URL...). The proxy key is a secret:
 * MODEL_PROXY_KEY, or the env var named by `modelProxyKeyEnv`.
 */
export const provider = defineProvider({
  name: "acp",
  provides: {
    agent: (ctx) =>
      fromEnv(
        envWithOptions(
          "acp",
          ctx,
          {
            agent: "ACP_AGENT",
            command: "ACP_AGENT_COMMAND",
            model: "WORKER_MODEL",
            modelProxyUrl: "MODEL_PROXY_URL",
            configDir: "ACP_CONFIG_DIR",
            debug: "ACP_DEBUG",
          },
          { modelProxyKeyEnv: "MODEL_PROXY_KEY" },
        ),
        (line) => ctx.log("agent-acp", { line }),
      ),
  },
});
