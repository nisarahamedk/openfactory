# @openfactory/agent-acp

Runs a coding agent that speaks the Agent Client Protocol (ACP) inside a workspace, over its stdio.
Today it wires Claude Code through `@agentclientprotocol/claude-agent-acp` (pinned in the worker image).

- One task = one ACP session. `openSession` with `resumeSessionId` starts a new agent process and
  calls `session/resume` (or `session/load`), so review rounds continue the same conversation.
  The transcript lives on the workspace's disk (`$HOME/.claude` or `CLAUDE_CONFIG_DIR`).
- The factory's system prompt is appended to Claude Code's own.
- Mode is `bypassPermissions` and permission requests are allowed: the workspace is the sandbox.
- Turn cost comes from the agent's `usage_update`; the model proxy stays the authority.

## Settings (`fromEnv`)

| Variable | Required | Meaning |
|---|---|---|
| `WORKER_MODEL` | yes | Model id, e.g. `claude-sonnet-5-5`. Benchmark arms change it. |
| `MODEL_PROXY_URL` | yes | Base URL of the model proxy (LiteLLM), as reachable from the workspace. |
| `MODEL_PROXY_KEY` | yes | Proxy key with its own budget. The org's real key never enters a sandbox. |
| `ACP_AGENT` | no | `claude-code` (default; the only one wired). |
| `ACP_AGENT_COMMAND` | no | Command that starts the adapter, default `claude-agent-acp`. |
| `ACP_CONFIG_DIR` | no | Claude Code config dir; default lets the workspace decide. |
| `ACP_DEBUG` | no | `1` prints the agent's non-protocol output. |

## Testing without spending money

`@openfactory/agent-acp/mock-anthropic` is a scripted Messages API (streaming and tool use).
Point `MODEL_PROXY_URL` at it. Only main-loop requests (the ones that offer tools) reach your
rules; side calls get `"ok"`. See `test/claude-code.test.ts`.
