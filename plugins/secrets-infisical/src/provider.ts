import { defineProvider } from "@openfactory/contracts";
import { fromEnv } from "./index.js";
import { envWithOptions } from "./options.js";

/**
 * factory.yaml: `secrets: { infisical: { projectId: <id>, environment: dev } }`.
 * Each option falls back to its env var (INFISICAL_PROJECT_ID, INFISICAL_ENVIRONMENT...). The machine
 * identity is secret: INFISICAL_CLIENT_ID/SECRET, or the env vars named by `clientIdEnv`/`clientSecretEnv`.
 */
export const provider = defineProvider({
  name: "infisical",
  provides: {
    secrets: (ctx) =>
      fromEnv(
        envWithOptions(
          "infisical",
          ctx,
          {
            siteUrl: "INFISICAL_SITE_URL",
            projectId: "INFISICAL_PROJECT_ID",
            environment: "INFISICAL_ENVIRONMENT",
            secretPath: "INFISICAL_SECRET_PATH",
            gitTokenName: "SECRETS_GIT_TOKEN_NAME",
          },
          { clientIdEnv: "INFISICAL_CLIENT_ID", clientSecretEnv: "INFISICAL_CLIENT_SECRET" },
        ),
      ),
  },
});
