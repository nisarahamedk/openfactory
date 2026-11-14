# openfactory (SlopwareFactory)

A self-hostable software factory: issues in, reviewed PRs with evidence out, and a record of every task that is kept up to date after the merge (scores, outcomes, cost), so a team can show what its AI spend buys.

Design: [docs/architecture.md](docs/architecture.md) (layers, actors, the capability registry, REST and MCP), [docs/plugins.md](docs/plugins.md), [docs/self-host.md](docs/self-host.md). Layout:

```
packages/contracts   shared schemas and plugin interfaces
packages/contract    the API contract: every operation, its input and output (OpenAPI is generated from it)
packages/core        domain + use cases + ports + the capability registry; knows nothing of HTTP or MCP
packages/*           ledger, task job, rules, foreman, scoring, bench, client, local MCP bridge
plugins/*            chat, code host, agent harness (ACP), workspace, environment, metrics
apps/server          entrypoints (REST /v1, MCP /mcp, CloudEvents, webhooks) + adapters, wired in main.ts
apps/*               dashboard (a client of the API), org-sim
deploy/*             compose, helm
```

Status: overnight build in progress on branch `claude/project-thread-8qi4s1`.
