# Experiential Labs model gateway

XOFT 0.10.2 can use Experiential Labs as an optional OpenAI-compatible multi-model gateway.
The gateway exposes many model slugs behind one endpoint and provides provider waterfalls/fallbacks. XOFT keeps its own ProviderRouter in front of it so the gateway is optional and can coexist with direct OpenAI, Gemini, Claude, Grok and Ollama providers.

## Configuration

```env
EXPERIENTIAL_API_KEY=
EXPERIENTIAL_BASE_URL=https://api.experientiallabs.ai/v1
EXPERIENTIAL_MODEL=gpt-5.6-luna
EXPERIENTIAL_FREE_ONLY=true
```

`EXPERIENTIAL_FREE_ONLY=true` is the safe zero-budget setting. Experiential
Labs' real API has no `:free` model-slug suffix (that convention belongs to
other gateways, not this one — verified against Experiential's own current
docs, which address models by plain slugs like `claude-opus-5`). XOFT never
rewrites the model slug you select. Instead, when free-only is on, XOFT
checks the authenticated `/v1/models` catalog for your key, and only calls
a model if it can positively confirm the catalog's pricing fields show zero
cost. If a model's price can't be determined at all, XOFT treats it as
**not** free and refuses to call it — failing closed, not guessing. A
rejected call tells you exactly why (unconfirmed cost) rather than silently
falling back to a paid model.

Set `EXPERIENTIAL_FREE_ONLY=false` only when paid platform credits are
explicitly intended.

## Runtime model switching

The authenticated Core API exposes:

- `GET /api/ai/model` — current Experiential model
- `GET /api/ai/models` — model catalog available to the configured key
- `POST /api/ai/model` — select a model on demand

Example:

```json
POST /api/ai/model
{
  "model": "claude-opus-5"
}
```

The selection is routed through `ProviderRouter`; the rest of XOFT continues using the same Core, memory, permissions, planning, tools and channels. `POST /api/ai/model` validates the submitted id against the live catalog before accepting it — a client can't set an arbitrary string and have XOFT silently try it at request time.

## Important

Model availability, regional eligibility, free-tier limits and pricing are controlled by Experiential Labs and can change. A model being visible in the public catalog does not guarantee that a particular organization/key can call it. Live provider behavior must be verified with a real `EXPERIENTIAL_API_KEY`.

The exact JSON field names Experiential's `/v1/models` response uses for
per-model pricing were not independently confirmed against a live,
authenticated response in this build (no test credentials were available).
`ExperientialProvider._isFreeCatalogEntry()` checks several plausible field
shapes and only treats a model as free when it can positively confirm a
zero price; an unrecognized or missing pricing shape is treated as **not**
free rather than assumed free. If your key's actual catalog response uses a
different field name than the ones checked, free-only mode may reject a
model that is genuinely free rather than the reverse — the safe direction
for a zero-budget guarantee to err in. If you hit that, check
`GET /api/ai/models`'s raw response and adjust
`_isFreeCatalogEntry()`'s candidate field list to match.
