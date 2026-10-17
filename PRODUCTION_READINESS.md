# Production Readiness

Implemented in this build:

- Native Android companion with configurable Core URL/API key, foreground agent, registration, heartbeat, capabilities, state, command polling/results, app launch, notifications, and accessibility actions.
- SQLite persistence for device identities and device command lifecycle using Node 22 `node:sqlite` with WAL mode.
- Production startup hardening: API authentication is mandatory in production, request IDs, Helmet, rate limiting, health/readiness endpoints, configurable host, graceful shutdown, and hidden production stack traces.
- Docker image and Compose deployment with persistent SQLite volume and health checks.
- GitHub Actions CI for backend tests/syntax checks/Docker build and Android debug APK build.
- GitHub Actions tag releases for Android APK/AAB and backend image validation.

Still required before a serious public multi-user/HA deployment:

1. Move all remaining JSON-backed state (memory, goals, workflows, etc.) to PostgreSQL or another transactional shared store.
2. Replace the shared API key for Android with one-time pairing + per-device credentials, rotation and revocation.
3. Use a durable distributed command/realtime layer (WebSocket/FCM + queue) for multi-instance deployments.
4. Configure Android release signing secrets and review current Google Play foreground-service/accessibility policies.
5. Put the backend behind HTTPS/TLS, WAF/reverse proxy, backups, monitoring, and alerting.
