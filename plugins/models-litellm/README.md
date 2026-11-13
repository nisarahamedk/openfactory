# @openfactory/models-litellm

`ModelGateway` on [LiteLLM](https://github.com/BerriAI/litellm). Each task gets its own LiteLLM key with the task's
budget (`max_budget`) and allowed models. The org's provider keys stay inside LiteLLM; a sandbox only ever sees its
task key. The key is derived from the task id (HMAC with the master key), so nothing is stored and a restart finds it.

- `forTask(taskId, { usd })` → `{ ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY }` (names configurable). Creates the key once.
- `spend(taskId)` → LiteLLM's spend for the key, or null if the key is gone.
- `revoke(taskId)` deletes the key; safe twice.

| Variable | Required | Meaning |
|---|---|---|
| `LITELLM_ADMIN_URL` | yes | LiteLLM admin API, e.g. `http://litellm.factory.svc:4000`. |
| `LITELLM_MASTER_KEY` | yes | Master key (factory side only). |
| `TASK_KEY_MODELS` | yes | Comma-separated models a task key may call. |
| `MODEL_PROXY_URL` | no | Base URL the agent uses; default `LITELLM_ADMIN_URL`. |
| `MODEL_ENV_BASE_URL`, `MODEL_ENV_KEY` | no | Env var names given to the agent; default `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`. |
