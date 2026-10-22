# Participation Coordinator

Native coordinator for the MotionMix Participation Network. Implements the
`ParticipationGateway` protocol (20 ops) over D1 (Cloudflare) or local SQLite.

**Protocol v2 (2026-10-22):** recovery by single-use grant (vouch or operator), server-issued invitations, principal-checked membership, audit, hourly GC. See `WIRING.md` §13 and `migrations/0002_v2_security_core.sql`.

**Deployed:** https://participation-coordinator.motionmix-participation.workers.dev
(D1 `participation`, region ENAM). Auth is a signed, short-lived, device-bound
bearer issued at `POST /participation/v1/token` (no dev prefix). See `WIRING.md`
§6 for live verification and §10 for the K11 tunnel runbook.

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
wrangler secret put COORD_TOKEN_SECRET   # >=32 random bytes, base64url (signs bearers)
wrangler secret put OPERATOR_BEARER_SHA256  # sha256 hex of the operator bearer (recovery grants)
wrangler d1 execute participation --remote --file migrations/0002_v2_security_core.sql   # v1 -> v2 once
# optional: expose K11's graph so facts land in the knowledge graph
# LKG_URL = "https://<tunnel>.trycloudflare.com"   (see WIRING.md §10)
npm run deploy
```

Set the app's `NativeParticipationCoordinatorConfiguration.baseURL` to the
Worker origin. `CoordinatorAccessTokenProvider` proves possession of the device
key to `/participation/v1/token` and returns the minted bearer; the Worker
resolves it to the device's actor in `auth`.

See `WIRING.md` for the full app->coordinator wiring, the token-issuer seam,
the K11 graph emission, and the exact Cloudflare deploy checklist.

## First user (prescribed)

A fresh database ships with one prescribed account, so the coordinator is usable
immediately — no client-side naming and no lazy first actor:

- actor `actor-mo-0001` / account `account-mo-0001`, `display_name = mo-motionmix`
  (equal to the app default recovery hint `participation.dev.actorID`), roles
  `[organizer, participant, viewer]`
- series `series-mo-0001` ("Motion Mix Sessions") and sphere `sphere-mo-studio`
  ("Studio"), both organized by that actor
- a subscription binding the actor to its own series

The Worker also calls `ensureFirstUser` on boot: on a database with **zero**
actors it lays the prescription down (idempotent); once any actor exists it is a
single COUNT and a no-op, so it never overwrites a live account.

```
npx tsx tools/bootstrap.ts                     # local .dev.sqlite (add --reset to clean first)
npx tsx tools/bootstrap.ts --sql --reset | bash tools/d1-apply.sh   # redeploy prescription to D1
npx tsx tools/bootstrap.ts --sql         | bash tools/d1-apply.sh   # idempotent, no reset
```

`tools/d1-apply.sh` exists because `wrangler d1 execute --file` returns
`{"D1_RESET_DO":true}` on this database; it runs rendered SQL statement by
statement through `--command`.

Every iPhone that launches the app registers its own P-256 device key and, on
recovery with the default hint, lands in `actor-mo-0001` with its own device
session — N devices share one account. Live proof: `tools/recover-first-user.ts`.

## Knowledge graph
`src/graph.ts` emits participation facts (`actor:`/`sphere:`/`membership:`
namespaces) as `NewTriple`s POSTed to `{LKG_URL}/api/knowledge` — the same route
`@foundry/lkg-client`'s `KGClient.addTriple` uses. `LKG_URL` points at K11 through
a Cloudflare Tunnel (a Tailscale address is unreachable from Workers). Emission is
off unless `LKG_URL` is set, so tests/CI stay offline.

## Contract facts (do not break)
- Request schema `motionmix.participation.native_request.v1`; response
  `motionmix.participation.native_response.v1`.
- Dates are ISO8601 whole seconds (`2026-10-11T17:30:00Z`).
- `payload_sha256` = sha256 of the canonical (sorted-keys) JSON of `payload`;
  the client re-encodes and compares, so key order and date form are load-bearing.
- Consent is append-only; a new row per decision; `revision` increments.
- Idempotency key is bound to (principal, operation, payload sha256).
