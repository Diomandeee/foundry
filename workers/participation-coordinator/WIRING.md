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

---

## 7. Device proofs: the framing the server MUST reproduce (2026-10-11)

The iOS client never signs a bare challenge string. `ParticipationDeviceKeyStore` /
`ParticipationEphemeralDeviceProofProvider` build a **domain-separated,
length-prefixed** message and sign that with P-256/SHA-256. The coordinator was
originally verifying the raw challenge string, which would have failed against
the real app; it now reproduces the framing exactly (`src/proof.ts`).

```
lp(x) = UInt32 big-endian byte count ‖ x            # Swift appendLengthPrefixed

subjectReferenceSHA256 = sha256("motionmix.participation.possession_subject.v1\0"
                                ‖ lp(purpose) ‖ lp(subjectReference))
joinAttemptReferenceSHA256 = sha256("motionmix.participation.join_attempt_subject.v1\0"
                                    ‖ lp(reference))

possession message = "motionmix.participation.device_possession_proof.v1\0"
                     ‖ lp(challengeID) ‖ lp(purpose) ‖ lp(subjectReferenceSHA256)
                     ‖ lp(deviceSessionID) ‖ lp(deviceKeyID) ‖ lp(challengeSHA256)
                     ‖ lp(challengeBytes)

admission message  = "motionmix.participation.admission_proof.v1\0"
                     ‖ lp(challengeID) ‖ lp(joinAttemptID) ‖ lp(joinAttemptReferenceSHA256)
                     ‖ lp(deviceSessionID) ‖ lp(deviceKeyID) ‖ lp(challengeSHA256)
                     ‖ lp(challengeBytes)
```

`challengeSHA256` is sha256 of the **decoded** challenge bytes, not of the
base64url text. The `challengeBase64URL` must decode to 16..128 bytes (the
coordinator issues 32 random bytes).

**Subject references the app re-derives and validates after every `begin*`:**
| purpose | subjectReference |
|---|---|
| `account_recovery` | the account hint |
| `app_clip_handoff_preparation` | the admission `membershipID` |
| `full_app_handoff_exchange` | the handoff `reference` |
| `full_app_session_resume` | the recovery handle |

These are byte-for-byte verified against output from the app's own Swift code:
`tools/proof-vectors.swift` (copy of the app's static functions) regenerates the
vectors asserted in `test/proof-vectors.test.ts`.

## 8. App wiring (done)

- `MotionMixApp/Participation/ParticipationCoordinatorBootstrap.swift` supplies the
  gateway's two inputs (origin + access token) and falls back to
  `UnconfiguredParticipationGateway` if the origin is unusable.
- `MotionMixApp.swift` now builds `ParticipationStore(gateway: …makeGateway())`.
- Override the origin at runtime with the `participation.coordinator.baseURL`
  UserDefaults key (default: the deployed Worker). `participation.dev.actorID`
  selects the account named by the temporary dev bearer.
- Each device has its own P-256 key (`ParticipationDeviceKeyStore`, this-device
  Keychain), so devices register independently and recover into one shared actor.

## 9. Multi-device registration (verified)

`complete_actor_recovery` resolves the actor as: already-bound device → its actor;
else an existing actor whose `display_name` matches the account hint; else the
authenticated principal. Verified in `test/app-parity.test.ts`: two devices with
different keys recover into the same actor with different device sessions.
