# openfactory (SlopwareFactory)

A self-hostable software factory: issues in, reviewed PRs with evidence out, and a record of every task that is kept up to date after the merge (scores, outcomes, cost), so a team can show what its AI spend buys.

Design: see `docs/` (coming) and the project write-ups. Layout:

```
packages/contracts   shared schemas and plugin interfaces (start here)
packages/*           core: ledger, task job, rules, foreman, scoring, bench
plugins/*            chat, code host, agent harness (ACP), workspace, environment, metrics
apps/*               server (one image), dashboard, cli
deploy/*             compose, helm
```

Status: overnight build in progress on branch `claude/project-thread-8qi4s1`.
