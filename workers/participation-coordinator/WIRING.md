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

---

## 6. DEPLOYED (2026-10-11) — live and verified

| Item | Value |
|---|---|
| Worker | `participation-coordinator` |
| URL | `https://participation-coordinator.motionmix-participation.workers.dev` |
| workers.dev subdomain | `motionmix-participation` (registered on the account) |
| D1 database | `participation` — id `b34d73d5-d1b1-4eee-8b74-e122355d6e40` (region ENAM) |
| Schema | applied remotely — 18 tables (`sqlite_master`), 12 consent instruments seeded |
| Secrets set | `COORD_SERVER_PKCS8`, `COORD_SERVER_SPKI`, `COORD_DEV_BEARER_PREFIX=dev` |
| Version | `15157a60-2b12-440a-8a36-9a37fcc150fa` |

### Verified against the live Worker (over the real client route `/participation/v1/native/*`)
- `smoke-client.ts` → **SMOKE PASS**: health, unauthorized, bad-schema, unknown-op,
  `request_id` echo, response schema, `payload_sha256` re-encode, **`create_sphere`
  durable write visible in `load_home`**.
- `smoke-flow.ts` → **FLOW PASS**: real DER P-256 device proof accepted on
  `complete_actor_recovery`, roles sorted, **replayed challenge rejected**.

```
URL=https://participation-coordinator.motionmix-participation.workers.dev
SMOKE_PATH_PREFIX=/participation/v1/native npx tsx tools/smoke-client.ts "$URL"
SMOKE_PATH_PREFIX=/participation/v1/native npx tsx tools/smoke-flow.ts   "$URL"
```

### App-side wiring (the one remaining code step)

`ConfiguredParticipationGateway.make(configuration:)` exists but nothing in the
app constructs it yet — deliberately, because the production token route was not
reviewed. To light it up (temporary bridge, until a real issuer exists):

```swift
// TEMPORARY dev bridge — the deployed Worker accepts `dev:<actorId>` because
// COORD_DEV_BEARER_PREFIX=dev. Replace with a real short-lived token issuer and
// delete the Worker secret before any real participant uses this.
struct DevParticipationTokenProvider: ParticipationAccessTokenProviding {
    let actorID: String
    func currentAccessToken() async throws -> String { "dev:\(actorID)" }
}

let configuration = try NativeParticipationCoordinatorConfiguration(
    baseURL: URL(string: "https://participation-coordinator.motionmix-participation.workers.dev")!,
    accessTokenProvider: DevParticipationTokenProvider(actorID: "mo-actor-0001")
)
let gateway = try ConfiguredParticipationGateway.make(configuration: configuration)
```

Then `gateway.loadHome()` returns the real home snapshot for that actor id.

### Two known gaps (honest)
1. **Dev bearer prefix is live.** `COORD_DEV_BEARER_PREFIX=dev` means anyone who
   knows the URL can act as any actor id. Remove it with
   `wrangler secret delete COORD_DEV_BEARER_PREFIX` as soon as a real token
   issuer exists (`auth` in `src/worker.ts` is the single seam).
2. **K11 is not reachable from Workers.** `LKG_URL=http://100.74.32.23:8002` is a
   Tailscale address; Cloudflare Workers cannot route to it, so participation→graph
   emission currently fails silently (it is non-fatal by design). To make facts
   land in K11, expose the Graph Kernel through a Cloudflare Tunnel hostname and
   point `LKG_URL` there.
