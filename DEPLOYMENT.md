# XOFT Production Deployment

## Docker Compose

1. Copy `.env.example` to `.env`.
2. Set `NODE_ENV=production` and a long random `AUTH_API_KEYS` value.
3. Add at least one AI provider key.
4. Run `docker compose up -d --build`.
5. Verify `/healthz` and `/readyz`.

SQLite is persisted in the `xoft-data` Docker volume. Back it up regularly. This deployment is intentionally single-instance; do not horizontally scale it until state and command coordination are moved to shared infrastructure.

## Android

Build the debug APK from CI or locally with Gradle 8.10.2 + JDK 17:

```bash
gradle --no-daemon :app:assembleDebug
```

Install the resulting `app-debug.apk`, enter the HTTPS Core URL and API key, start the foreground agent, then trust the registered device from the Core API/UI. Enable Accessibility and Notification Access only when those capabilities are needed.

## GitHub Actions

- `ci.yml` runs on pushes and pull requests.
- `release.yml` runs on `v*` tags and produces Android APK/AAB artifacts.
- Add Android signing secrets and a signing configuration before distributing the release build through an app store.

## Dependency verification

The release archive intentionally excludes `node_modules`. On a clean machine, install the exact lockfile dependency tree before starting XOFT:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run verify:deps
npm test
```

Do not copy a partial `node_modules` directory between releases. A failed dependency install must be treated as a deployment failure rather than worked around by committing or packaging dependencies.
