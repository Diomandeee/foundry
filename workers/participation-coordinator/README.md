# Participation Coordinator

Native coordinator for the MotionMix Participation Network. Implements the
`ParticipationGateway` protocol (20 ops) over D1 (Cloudflare) or local SQLite.

## Run locally
```
npm run dev          # http://localhost:8791
curl -s localhost:8791/health
```

## Test
```
npm test             # wire-contract + ops tests (node:sqlite, WebCrypto)
npm run smoke        # boots the dev server and proves the HTTP contract
npm run typecheck    # tsc --noEmit (clean)
```

## Deploy (Cloudflare)
```
wrangler d1 create participation
# paste the database_id into wrangler.toml
wrangler d1 execute participation --file schema.sql --remote
wrangler secret put COORD_SERVER_PKCS8   # P-256 pkcs8, base64url
wrangler secret put COORD_SERVER_SPKI    # matching public key, base64url
npm run deploy
```

Set the app's `NativeParticipationCoordinatorConfiguration.baseURL` to the
Worker origin. The app's `ParticipationAccessTokenProviding` must return a
short-lived token; the Worker resolves it to an actor id in `auth`.

See `WIRING.md` for the full app->coordinator wiring, the token-issuer seam,
the K11 graph emission, and the exact Cloudflare deploy checklist.

## Knowledge graph
`src/graph.ts` emits participation facts (`actor:`/`sphere:`/`membership:`
namespaces) in the same triple shape the foundry gate/orchestrator write to K11.
Emission is off unless `LKG_URL` is set, so tests/CI stay offline.

## Contract facts (do not break)
- Request schema `motionmix.participation.native_request.v1`; response
  `motionmix.participation.native_response.v1`.
- Dates are ISO8601 whole seconds (`2026-10-11T17:30:00Z`).
- `payload_sha256` = sha256 of the canonical (sorted-keys) JSON of `payload`;
  the client re-encodes and compares, so key order and date form are load-bearing.
- Consent is append-only; a new row per decision; `revision` increments.
- Idempotency key is bound to (principal, operation, payload sha256).
