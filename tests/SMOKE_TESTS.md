# Smoke test checklist

After installing and starting the service:

1. `GET /api/health` returns `{ "ok": true }` without requiring an access token.
2. When `AUTH_TOKEN` is set, `GET /api/status` rejects requests without a Bearer token.
3. With a provider key configured, `POST /api/chat` returns a reply and a conversation ID.
4. `POST /api/memory` followed by `GET /api/memory` returns the note.
5. `POST /api/tasks` and `PATCH /api/tasks/:id` create and complete a task.
6. Approval decisions are recorded but do not execute external actions.
7. Restart the process and confirm JSON-backed records persist when `DATA_DIR` is on persistent storage.

The project has not been run in a CI environment as part of this change; these are verification steps, not a claim of passing tests.