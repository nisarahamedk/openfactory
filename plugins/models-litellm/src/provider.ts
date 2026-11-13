import { defineProvider } from "@openfactory/contracts";
import { fromEnv } from "./index.js";
import { envWithOptions } from "./options.js";

/**
 * factory.yaml: `modelGateway: { litellm: { adminUrl: http://litellm:4000, models: [claude-sonnet-4-5] } }`.
 * Each option falls back to its env var (LITELLM_ADMIN_URL, TASK_KEY_MODELS...). The master key is a
 * secret: LITELLM_MASTER_KEY, or the env var named by `masterKeyEnv`.
 */
export const provider = defineProvider({
  name: "litellm",
  provides: {
    modelGateway: (ctx) =>
      fromEnv(
        envWithOptions(
          "litellm",
          ctx,
          {
            adminUrl: "LITELLM_ADMIN_URL",
            agentBaseUrl: "MODEL_PROXY_URL",
            models: "TASK_KEY_MODELS",
            baseUrlVar: "MODEL_ENV_BASE_URL",
            keyVar: "MODEL_ENV_KEY",
          },
          { masterKeyEnv: "LITELLM_MASTER_KEY" },
        ),
      ),
  },
});
