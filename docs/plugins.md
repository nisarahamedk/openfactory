# Plugins: abstractions, providers and open protocols

Status: **Decided** by Nisar on 2026-11-13. Migration steps 1 and 3 are done (renames, `github` provider, provider registry with `factory.yaml`; example in `examples/factory/factory.yaml`); the rest is in progress.

## The rule

- **An abstraction** is an interface in `packages/contracts`. It is part of the core. Core code depends only on abstractions.
- **A provider** is a package that implements one or more abstractions. It is named after the vendor or protocol, not the abstraction: one `github` provider registers CodeForge, Signals, Chat and WorkTracker.
- **Open protocol first.** At each place where the factory meets an organisation's tools, use the open standard if one exists and real clients speak it. Write our own interface only where no standard exists.
- **Protocols at the edge, our contracts inside.** Each protocol lives in one adapter package, pinned to an exact version. The core never imports a protocol SDK. When a protocol changes, one package changes.
- **Every abstraction has a conformance suite.** A new provider must pass it. A faithful fake for every abstraction lives next to the suite and is used in tests.
- **Providers are picked in `factory.yaml`**, not by hard-coded env vars:

  ```yaml
  providers:
    codeForge: github
    workTracker: jira
    agent: { acp: claude-code }
    telemetry: { otlp: https://otel.example:4318 }
  ```

## What stays core (not pluggable)

| Part | Why |
|---|---|
| Rules (`decide`) | "Humans merge" and "evidence before review" are guarantees only if no plugin can replace them. Org rules are added through Policy, on top. |
| Ledger | It is the system of record. Scorers, benchmarks and the dashboard read only the ledger, never an exporter. |
| Task job | It owns ordering, retries and checkpoints. The durable engine (pi-durable today) sits behind it. |

## Abstractions

| Abstraction | Job | Open protocol | Providers (example) | Today |
|---|---|---|---|---|
| CodeForge | branches, PRs, push tokens, CI status | (none common) | GitHub, GitLab, Bitbucket | `CodeForge` in the `github` provider |
| WorkTracker | issues, tickets, status, links | MCP for agent access | Jira, Linear, GitHub Issues | missing |
| Signals | events that start or wake a task | webhooks, CloudEvents | GitHub, Jira, Slack, Datadog alerts | `SignalSource` |
| Chat | talk to people where the task lives | (none common) | PR comments, Slack, Teams | `Chat` in the `github` provider |
| AgentHarness | the coding agent | **ACP** | Claude Code, Codex, Copilot CLI, Gemini, Pi | `agent-acp` |
| Workspace | where the agent's tools run | OCI images, Kubernetes | k8s pod, agent-sandbox, E2B, Vercel, local | `workspace-k8s`, `workspace-local` |
| DevEnvironment | the running product to deploy and test | Kubernetes | DevSpace, Okteto, OpenWorld | `env-devspace` |
| ModelGateway | model access, keys, budget per task | OpenAI- / Anthropic-compatible HTTP | LiteLLM, Bedrock, Portkey | wired in directly |
| Secrets | short-lived credentials per task | OIDC workload identity where possible | Infisical, Vault, cloud secret managers | missing |
| EvidenceStore | screenshots, videos, logs, transcripts | **S3 API** | disk, S3, R2, MinIO | internal |
| Telemetry | traces, metrics and logs out | **OpenTelemetry** (GenAI conventions) | any OTLP backend: Datadog, Grafana, Honeycomb, Langfuse | `telemetry-otlp` (task, phases, turns; tool-call and model-call spans not yet), enabled by `OTEL_EXPORTER_OTLP_ENDPOINT` |
| Scorer | grade one task record | (none) | facts, LLM judge, world checks | `Scorer` |
| Metrics | rows to org dashboards | CDEvents (check adoption first) | DX, DevLake | `MetricsSink` |
| OutcomeSource | outcomes after the merge | webhooks | Rootly, PagerDuty, Datadog monitors, reverts | half (fake DX incidents) |
| Benchmark | capture and replay tasks | **Harbor** task format | Harbor folders | `packages/bench`, not swappable |
| Rollout | canary and 10% routing of factory versions | OpenFeature (check adoption first) | any flag service, built-in random | missing |
| Identity | the same person across tools; who may start a task | **OIDC/SAML**, **SCIM** | Okta, Entra, Google | missing |
| ReviewRouter | pick reviewers and approvers | (none) | CODEOWNERS, on-call rota | missing |
| Knowledge | context the agent gets | **MCP** | repo docs, Confluence, skill files | env skill file only |
| Policy | org rules added on top of the core rules | OPA (optional) | rules file, OPA | missing |

The factory also exposes itself through open protocols, so an org's own agents and tools can use it:

- an **MCP server** ("status of task 42", "add to benchmark");
- **OpenAPI** for `/v1`.

Install uses an **OCI image**, a Helm chart and an **OpenTofu/Terraform** module; Alchemy is the option for TypeScript shops.

## Sandbox security

Decided by Nisar on 2026-11-13, replacing the earlier "server pushes, sandbox read-only" design.

- **The agent works like an engineer.** It pushes its branch, opens the PR and comments with `git` and `gh`. A read-only agent would push all of that into the server, and Warp and Open-Inspect don't work that way either.
- **One credential per task, scoped to one repo.** `CodeForge.mintPushToken(repo)` hands the agent a token for the task's repo only. It is short-lived where the forge allows it (GitHub App installation token, 1 h, refreshed before each turn) and revoked when the task ends. Until the GitHub App exists, it is a fine-grained PAT limited to that repo. With a `secrets` provider, the token comes from `Secrets.issue({ kind: "git", repo, access: "write" })`. Model access is a per-task gateway key with the task's budget (`ModelGateway`).
- **Branch protection is the merge control.** `main` requires review, and humans merge. The factory's rules never merge.
- **No open internet from sandboxes. This is the main control.** All sandbox egress goes through an egress proxy, deny by default. The allowlist holds the forge (github.com and its API), the model gateway, the package registries the repo needs (npm, …) and the task's own dev environment. NetworkPolicy blocks every other route out of the sandbox namespace. The allowlist is per factory (`factory.yaml`, `egress.allow`).
- **Every request is recorded.** The proxy's log is aggregated per task, host and minute and posted to `POST /v1/egress`. It lands in the ledger as `egress` events, denied requests included, so a reviewer and the scorers can see what the agent reached.
- **What a leaked token can do:** push branches and comment on one repo for up to an hour. It cannot merge to `main`, reach other repos, or send data anywhere outside the allowlist.

## Observability

Three layers, kept apart:

1. **Ledger (core).** The facts we judge with. Not exported as the source of truth; exported as a copy.
2. **Transcripts.** Each AgentHarness provider turns its own session format into one trace shape. Our copy goes to the EvidenceStore, with a pointer in the ledger. Scorers and self-improvement read this copy.
3. **Export (Telemetry).** OTLP out:

   ```
   trace  = task          (factory version, repo, issue)
     span   intake | review round N | finalize
       span   agent turn  (model, tokens, cost)
         span   tool call   (bash, edit, deploy…)
         span   model call  (from the gateway)
   ```

Rules:

- **Export everything, read back nothing.** Our scorers never depend on an org's retention or query API.
- **Redaction runs before export.** Traces hold code, prompts and sometimes secrets.
- **Reading an org's tools is a different abstraction.** A Datadog monitor firing after a merge is an OutcomeSource; an alert that should start a task is a Signal.

Not yet verified against current docs:

- the maturity of the OTel GenAI conventions;
- whether Datadog LLM Observability accepts them;
- that Claude Code and LiteLLM each export OTel natively.

## Migration from today's code

1. Rename `CodeHost` → `CodeForge` and `ChatSurface` → `Chat`; split `code-github` into one `github` provider that registers several abstractions.
2. Add `ModelGateway`, `Secrets`, `EvidenceStore` and `Telemetry` contracts. Move the per-task repo token and per-task model key behind `Secrets` and `ModelGateway`. With the egress allowlist, this closes the sandbox gaps from the security review (see Sandbox security).
3. Add a provider registry and `factory.yaml` loading. Keep env-var config as a fallback.
4. Add a conformance suite per abstraction, starting with Workspace, DevEnvironment and AgentHarness.
5. Add the factory's own MCP server over the `/v1` routes.
