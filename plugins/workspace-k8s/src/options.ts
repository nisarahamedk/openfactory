import type { ProviderContext } from "@openfactory/contracts";

/**
 * factory.yaml options win over env vars. Each option stands for one env var;
 * a list becomes "a,b", a map becomes "K=v,K2=v2". Secret values never come
 * from options: a `secretEnv` option names the env var to read the secret from.
 * Unknown options are an error, so a typo fails at startup.
 */
export function envWithOptions(
  provider: string,
  ctx: Pick<ProviderContext, "options" | "env">,
  options: Record<string, string>,
  secretEnv: Record<string, string> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...ctx.env };
  for (const [key, value] of Object.entries(ctx.options)) {
    if (value === undefined || value === null) continue;
    const plain = options[key];
    const secret = secretEnv[key];
    if (plain !== undefined) env[plain] = asEnvValue(value);
    else if (secret !== undefined) {
      if (typeof value !== "string" || value === "") throw new Error(`${provider}: option ${key} names an env var`);
      env[secret] = ctx.env[value];
    } else {
      const known = [...Object.keys(options), ...Object.keys(secretEnv)].sort().join(", ");
      throw new Error(`${provider}: unknown option "${key}" (known: ${known})`);
    }
  }
  return env;
}

function asEnvValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(",");
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).map(([k, v]) => `${k}=${String(v)}`).join(",");
  }
  return String(value);
}
