# Security policy

## Current security scope

XOFT is an early, single-user MVP. It has not received an independent security audit and is not yet appropriate for sensitive production data.

Before exposing the service publicly:

1. Set `NODE_ENV=production`.
2. Keep `REQUIRE_AUTH_IN_PRODUCTION=true`.
3. Set `AUTH_API_KEYS` to one or more long, randomly generated secrets in the hosting provider's secret/environment-variable settings. Separate multiple keys with commas.
4. Never commit real provider keys, API keys, tokens, or passwords to the repository.
5. Review the deployment's persistence, backup, access-control, and network configuration.

The server refuses to start in production when authentication is required but `AUTH_API_KEYS` is empty. API requests use `Authorization: Bearer <key>` or `X-API-Key: <key>`. Device tokens are separately scoped and must not be treated as administrator keys.

The environment variable is `AUTH_API_KEYS` — not `AUTH_TOKEN`.

Provider keys must only be stored in hosting secrets/server environment variables. Do not expose provider keys in browser code.

## Reporting

Please do not publish credentials, tokens, session cookies, or private conversations in issues. Report suspected vulnerabilities privately to the repository owner.

## Known limitations

- JSON persistence is not a multi-user database and does not provide encryption at rest.
- The access key is a shared bearer secret, not a full user/session system.
- Approval records do not execute actions; external integrations are not enabled.
- Browser speech APIs vary by browser and may send audio to browser-vendor services.
- No independent security audit has been completed.
