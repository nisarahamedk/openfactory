import type { RepoRef } from "@openfactory/contracts";

/**
 * Names to look up for a git token, most specific first: a repo-specific
 * token (GITHUB_TOKEN_ACME_WEB) and then the default.
 */
export function gitTokenNames(repo: RepoRef, defaultName: string): string[] {
  const part = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return [`${defaultName}_${part(repo.owner)}_${part(repo.name)}`, defaultName];
}
