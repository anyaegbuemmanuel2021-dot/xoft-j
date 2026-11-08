# Security policy

## Current security scope

This is an early single-user MVP, not yet audited or appropriate for sensitive production data. Do not expose it publicly without setting `NODE_ENV=production` and a strong `AUTH_TOKEN`. Provider keys must only be stored in hosting secrets/server environment variables.

## Reporting

Please do not publish credentials, tokens, session cookies, or private conversations in issues. Report suspected vulnerabilities privately to the repository owner.

## Known limitations

- JSON persistence is not a multi-user database and does not provide encryption at rest.
- The access token is a shared bearer secret, not a full user/session system.
- Approval records do not execute actions; external integrations are not enabled.
- Browser speech APIs vary by browser and may send audio to browser-vendor services.
- No independent security audit has been completed.
