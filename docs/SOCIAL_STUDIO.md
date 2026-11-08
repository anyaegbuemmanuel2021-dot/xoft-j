# XOFT Social Studio

Social Studio is a persistent workspace for organizing multiple public social
media handles, recording a style guide from material supplied by the account
owner, and creating original content drafts.

## What works

- Register multiple handles for Instagram, TikTok, YouTube, Facebook, LinkedIn,
  X, Threads, and Pinterest.
- Persist account metadata in XOFT's configured SQLite store (or JSON-backed
  storage when SQLite mode is not selected).
- Keep an independent per-handle kill switch. New handles start stopped;
  **KILL SWITCH** marks the selected handle stopped and disables its workflow
  flag without changing other handles. Arming a handle only changes that
  handle's workflow flag.
- Store niche, target audience, notes, and up to 20 sample posts per handle.
- Use a configured AI provider to analyze supplied samples and save a reusable
  high-level style guide.
- Generate and save original captions, carousel outlines, short-video scripts,
  threads, and content-plan drafts.
- Copy drafts to the clipboard and review the saved analysis/draft history.

## Honest boundaries

- A profile URL is validated and saved as a reference; **XOFT does not fetch or
  scrape the live profile in this version**. Paste sample content that you are
  permitted to analyze.
- Draft generation is not publishing. No social platform receives a post from
  Social Studio, and the UI never reports a draft as published.
- The per-handle kill switch protects the handle's workflow flag. There is not
  yet a scheduled publisher connected to that flag because platform publishing
  adapters have not been implemented.
- Automatic posting, comment/DM handling, reach/engagement analytics, and
  autonomous content discovery require separate official platform API
  integrations, account permissions, credentials, rate-limit handling, and
  end-to-end tests. Do not supply platform passwords or session cookies to XOFT.
- Content analysis uses the samples as untrusted reference data, not as
  instructions. Drafts should be reviewed for accuracy, rights, and brand fit
  before manual publication.

## Dashboard workflow

1. Open **Social Studio** in XOFT.
2. Add one handle for each platform/account. Each new handle starts paused.
3. Add profile notes and paste sample posts, then save.
4. Choose **Analyze style** to save a high-level content style guide.
5. Enter a content goal and choose a draft format, then select **Generate draft**.
6. Review and copy the draft. It is not posted automatically.
7. Use **KILL SWITCH** to stop that handle's workflow flag. Use **Enable workflow**
   only when you deliberately want to re-arm the handle.

## API

All endpoints are under `/api/social/handles` and use XOFT's normal API
authentication.

- `GET /api/social/handles` — list saved handles.
- `POST /api/social/handles` — create a handle.
- `POST /api/social/handles/:id/update` — update notes, niche, audience,
  profile URL, or sample posts.
- `POST /api/social/handles/:id/analyze` — analyze the supplied material.
- `POST /api/social/handles/:id/drafts` — generate and save a draft.
- `POST /api/social/handles/:id/kill` — stop one handle.
- `POST /api/social/handles/:id/arm` — re-enable one handle's workflow flag.
- `POST /api/social/handles/:id/remove` — remove the handle and its saved drafts.

Social Studio routes are intentionally not allowlisted for per-device tokens;
the account-management controls require the normal owner/admin credential.
