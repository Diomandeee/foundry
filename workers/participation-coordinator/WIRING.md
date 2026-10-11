# Wiring: MotionMix app -> Participation Coordinator

The iOS `ParticipationGateway` client is already written. It becomes "the
participation network" the moment its `baseURL` points at this coordinator.
Nothing in the app needs to change except configuration plus a token issuer.

## 1. Point the app at the coordinator

`NativeParticipationCoordinatorConfiguration.baseURL` (see
`MotionMixApp/Participation/Core/ConfiguredParticipationGateway.swift`) must be
the coordinator origin. The transport then calls:

```
POST {baseURL}/participation/v1/native/{operation}
Authorization: Bearer <short-lived token>
```

- **Local / simulator:** `http://127.0.0.1:8791` (loopback is the only non-HTTPS
  shape the client allows). Run `npm run dev` in this package.
- **Production:** `https://<worker>.workers.dev` (or a custom domain). HTTPS is
  enforced by the client except on loopback.

### Path prefix note
The client posts to `/participation/v1/native/{operation}`. This coordinator's
Worker currently accepts any `POST` path and routes on the **envelope**, so it
works with that prefix out of the box. If you later add a router, keep the
`/participation/v1/native/*` prefix as the mount point.

## 2. Token issuer (the one real gap)

The client sends a bearer via `ParticipationAccessTokenProviding`; the coordinator
resolves it to an actor id in `auth`. Today the only issuer is dev:

- **Dev:** bearer `dev:<actorId>` (see `src/app.ts` `devAuth`, or
  `COORD_DEV_BEARER_PREFIX` in the Worker). Used by tests and the smoke script.
- **Production:** issuer not built yet. Two supported shapes:
  1. Cloudflare Access JWT verified upstream (principal = the `sub`/actor claim).
  2. A signed token exchanged at a `/token` route you add.
  `src/worker.ts` `auth` is the single seam — implement there, nothing else moves.

## 3. Knowledge Graph (K11)

Participation state is emitted as graph triples via `src/graph.ts`
(`actor:` / `sphere:` / `membership:` / `source:` namespaces), using the same
`NewTriple` shape `@foundry/lkg-client` writes from the gate and orchestrator.
`LKG_URL` is set in `wrangler.toml` (`http://100.74.32.23:8002`) and the Worker
emits via `waitUntil`, so a graph outage never fails a request. Unset
`LKG_URL` -> the coordinator is a pure function of its database (CI default).

## 4. Deploy (needs Cloudflare: Mohameds)

```
wrangler d1 create participation             # copy database_id into wrangler.toml
wrangler d1 execute participation --file schema.sql --remote
wrangler secret put COORD_SERVER_PKCS8        # P-256 pkcs8, base64url
wrangler secret put COORD_SERVER_SPKI         # matching SPKI public key
wrangler secret put COORD_DEV_BEARER_PREFIX   # optional; remove in prod
npm run deploy
```

Generate the P-256 pair with:
```
openssl ecparam -name prime256v1 -genkey -noout -out key.pem
openssl pkcs8 -topk8 -nocrypt -in key.pem -outform DER | base64 | tr '+/' '-_' | tr -d '='
openssl ec -in key.pem -pubout -outform DER | base64 | tr '+/' '-_' | tr -d '='
```
(pkcs8 value -> `COORD_SERVER_PKCS8`, spki value -> `COORD_SERVER_SPKI`.)

## 5. Verify without Cloudflare

```
npm test        # 12 wire/contract/op tests, node:sqlite + WebCrypto
npm run smoke   # boots the dev server, runs the full HTTP contract
```
