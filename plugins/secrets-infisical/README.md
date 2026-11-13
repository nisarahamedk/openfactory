# @openfactory/secrets-infisical

`Secrets` from [Infisical](https://infisical.com), read with a machine identity (universal auth). The access token is
cached until a minute before it expires.

- `get(name)` reads one secret; a missing one throws `SecretNotFound`.
- `issue({ kind: "git", repo })` returns `GITHUB_TOKEN_<OWNER>_<REPO>` if present, else `GITHUB_TOKEN`
  (the default name is configurable). **Values are static, so `expiresAt` is null.** For short-lived push
  tokens, put a GitHub App provider behind the same contract.

| Variable | Required | Meaning |
|---|---|---|
| `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET` | yes | Machine identity. |
| `INFISICAL_PROJECT_ID` | yes | Project (workspace) id. |
| `INFISICAL_ENVIRONMENT` | no | Default `dev`. |
| `INFISICAL_SECRET_PATH` | no | Default `/`. |
| `INFISICAL_SITE_URL` | no | Default `https://app.infisical.com`; set it for self-hosted Infisical. |
| `SECRETS_GIT_TOKEN_NAME` | no | Default `GITHUB_TOKEN`. |
