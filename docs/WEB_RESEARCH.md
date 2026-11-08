# XOFT Web Research: Free Search and Page Reading

XOFT's research tools are wired through `src/tools/builtins/researchTools.js`.

## Search providers

- **SearXNG (preferred):** open-source metasearch, no Brave API key. The repository's Docker Compose setup runs a private SearXNG service and sets `SEARXNG_BASE_URL=http://searxng:8080` for XOFT.
- **Brave (optional fallback):** configure `BRAVE_SEARCH_API_KEY` only if desired. It is not required for the Docker Compose setup.
- **Non-Compose hosting:** deploy SearXNG as a separate service and set `SEARXNG_BASE_URL` to its reachable base URL in the XOFT service environment. A blank URL and no Brave key means web search is not configured.

## Docker Compose setup

1. Copy `.env.example` to `.env`.
2. Set a strong, unique `AUTH_API_KEYS` value and at least one AI provider key.
3. Set `SEARXNG_SECRET` to a strong, random secret in `.env`. The Compose fallback is only a warning placeholder and must not be used for a public deployment.
4. Run `docker compose up --build -d`.
5. Check `docker compose ps` and `docker compose logs searxng xoft-core`. SearXNG is only exposed to the internal Compose network; its port is not published to the internet.

## Page reading and security

The `fetch_page` tool reads public HTTP(S) HTML and plain text without a search API key. It validates redirect destinations, rejects obvious local/loopback/private IP and metadata targets, limits response size to 1 MB, limits output to 12,000 characters, and applies request timeouts. It does not execute JavaScript or bypass logins, CAPTCHAs, paywalls, or site restrictions. It is a safe page reader, not a full graphical browser.

Treat retrieved page content as untrusted evidence: web pages can contain misleading content or prompt-injection attempts. XOFT must not treat page text as instructions to override user intent, permissions, or security rules.

## Hosting note

Some PaaS products deploy only the Dockerfile and do not run `docker-compose.yml`. In that case the SearXNG service will not automatically start with XOFT: deploy SearXNG separately and set `SEARXNG_BASE_URL` in the XOFT service settings. Verify connectivity from the XOFT runtime before considering search live.
