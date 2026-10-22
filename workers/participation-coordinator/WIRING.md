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

## 2. Token issuer (real, device-bound)

`POST /participation/v1/token` (see `src/token.ts`) mints the bearer the client
sends via `ParticipationAccessTokenProviding`. There is **no** `dev:` prefix and
no shared secret in the app.

- A token is `mmt1.<payload>.<hmac>` — HMAC-SHA256 over the payload with the
  Worker secret `COORD_TOKEN_SECRET`, carrying `{v,aud,sub,dk,iat,exp}`.
- It is **short-lived** (1 h) and **device-bound** (`dk` = the P-256 key id that
  requested it). `verifyToken` rejects any token not signed with the secret, and
  `auth` (`src/worker.ts`) resolves the live principal from the device row.
- Issuance is **proof-gated**: the caller signs `token_request.v1 || lp(keyID) ||
  lp(publicKey) || lp(nonce) || lp(issuedAt)` with its own device key
  (`src/token.ts tokenRequestMessage`, byte-identical to the app's Swift — see
  `tools/token-vectors.swift` + `test/token.test.ts`). A caller can only obtain a
  token for a key it holds; nonce replay and clock skew (>120 s) are rejected.
- `COORD_DEV_BEARER_PREFIX` is **deleted** from the Worker. `src/app.ts devAuth`
  survives only as the local/CI default for `npm test` and `npm run dev`; the
  deployed Worker has no prefix fallback and fails closed with no secret.

## 3. Knowledge Graph (K11)

Participation state is emitted as graph triples via `src/graph.ts`
(`actor:` / `sphere:` / `membership:` / `source:` namespaces), using the same
`NewTriple` shape `@foundry/lkg-client` writes from the gate and orchestrator.
`LKG_URL` is set in `wrangler.toml` to a **Cloudflare Tunnel** hostname on K11
(a Tailscale address like `http://100.74.32.23:8002` is unreachable from Workers).
The emitter POSTs each triple as `NewTriple` to `{LKG_URL}/api/knowledge` — the
route `@foundry/lkg-client`'s `KGClient.addTriple` uses and the one the K11 graph
kernel serves (the earlier `/triples` path was wrong and silently 404'd).

The Worker emits via `waitUntil`, so a graph outage never fails a request. Unset
`LKG_URL` -> the coordinator is a pure function of its database (CI default).

## 4. Deploy (needs Cloudflare: Mohameds)

```
wrangler d1 create participation             # copy database_id into wrangler.toml
wrangler d1 execute participation --file schema.sql --remote
wrangler secret put COORD_SERVER_PKCS8        # P-256 pkcs8, base64url
wrangler secret put COORD_SERVER_SPKI         # matching SPKI public key
wrangler secret put COORD_TOKEN_SECRET        # >=32 random bytes, base64url (signs bearers)
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
| Secrets set | `COORD_SERVER_PKCS8`, `COORD_SERVER_SPKI`, `COORD_TOKEN_SECRET` (no dev prefix) |
| Token issuer | `POST /participation/v1/token` — signed, 1 h, device-bound |
| Version | `a7d2a992-1ff7-45c0-a85d-616c63e650d4` |

### Verified against the live Worker (over the real client route `/participation/v1/native/*`)
- `smoke-client.ts` → **SMOKE PASS**: health, unauthorized, bad-schema, unknown-op,
  `request_id` echo, response schema, `payload_sha256` re-encode, **`create_sphere`
  durable write visible in `load_home`**.
- `smoke-flow.ts` → **FLOW PASS**: real DER P-256 device proof accepted on
  `complete_actor_recovery`, roles sorted, **replayed challenge rejected**.

```
URL=https://participation-coordinator.motionmix-participation.workers.dev
SMOKE_PATH_PREFIX=/participation/v1/native npx tsx tools/smoke-client.ts "$URL"
SMOKE_PATH_PREFIX=/participation/v1/native \
  COORD_GRAPH_URL=https://<tunnel>.trycloudflare.com npx tsx tools/smoke-flow.ts "$URL"
```

Both now mint a **real** device-bound token from the issuer (no `dev:` bearer) and
assert that a `dev:<actorId>` bearer is rejected (`SMOKE PASS` + `FLOW PASS`).
`COORD_GRAPH_URL` additionally asserts the emission landed in K11. Locally, run
`bash tools/coordinator-smoke.sh` (boots the dev server in real-issuer mode).

### App-side wiring (done)

`ParticipationCoordinatorBootstrap.makeGateway()` constructs
`ConfiguredParticipationGateway` and is built into `ParticipationStore` in
`MotionMixApp.swift`. `CoordinatorAccessTokenProvider` fetches the real token:
it signs the token-request frame with this device's P-256 key and POSTs it to
`{baseURL}/participation/v1/token`. No dev bridge remains.

### Both original gaps are closed (2026-10-11)
1. **Dev bearer prefix deleted.** The Worker now issues signed, expiring,
   device-bound tokens at `POST /participation/v1/token`; `wrangler secret list`
   no longer contains `COORD_DEV_BEARER_PREFIX`, and both smokes assert a
   `dev:<actorId>` bearer is rejected.
2. **K11 reached through a Cloudflare Tunnel.** `LKG_URL` is a tunnel hostname
   and a live flow confirms a triple landed in the K11 graph. Caveat below.

### One caveat left (honest)
- The K11 tunnel is a **quick tunnel**, so its hostname rotates on restart
  (`https://<random>.trycloudflare.com`). The account has **no Cloudflare zone**,
  so no stable custom hostname is possible yet. After a tunnel restart, update
  `LKG_URL` in `wrangler.toml` and redeploy (runbook: §10). Register a domain on
  the account to move to a named tunnel with a fixed hostname.

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
- `MotionMixApp.swift` builds `ParticipationStore(gateway: …makeGateway(),
  defaultAccountHint: …defaultAccountHint())`.
- `ParticipationDeviceKeyStore.signCoordinatorTokenRequest` signs the token
  request (shares the length-prefixed framing with the challenge proofs).
- `CoordinatorAccessTokenProvider` calls the issuer and returns the signed
  bearer. Each device has its own P-256 key, so devices register independently
  and recover into one shared actor (actor resolved server-side).
- Runtime overrides (UserDefaults): `participation.coordinator.baseURL` points the
  app at another origin; `participation.dev.actorID` seeds the recovery account
  hint so two devices land in the same actor (the actor id itself is now
  server-derived from the device key, not client-chosen).

## 9. Multi-device registration (verified)

`complete_actor_recovery` resolves the actor as: already-bound device → its actor;
else an existing actor whose `display_name` matches the account hint; else the
authenticated principal. Verified in `test/app-parity.test.ts`: two devices with
different keys recover into the same actor with different device sessions.

## 10. K11 Cloudflare Tunnel runbook (quick tunnel)

The account has no zone, so K11's graph kernel is reached through a quick tunnel.

On K11 (Windows, `ssh k11`):
```
# cloudflared lives at C:\ai-memory\bin\cloudflared.exe; graph-vc serves :8002
schtasks /Run   /TN ai-memory-graph-vc            # start the graph kernel (if down)
schtasks /Run   /TN ai-memory-cloudflared-gvc     # start the tunnel
powershell -Command "Get-Content C:\ai-memory\logs\cloudflared-gvc.log | \
  Select-String trycloudflare.com | Select-Object -Last 1"   # read the URL
```
Then set `LKG_URL` in `wrangler.toml` to that URL and `npm run deploy`. Verify:
```
curl -s https://<tunnel>.trycloudflare.com/health                       # {"status":"healthy"}
curl -s -X POST https://<tunnel>.trycloudflare.com/api/knowledge \
  -H 'content-type: application/json' \
  -d '{"subject":"probe","predicate":"reaches","object":"k11"}'
```
The `ai-memory-cloudflared-gvc` task is `ONSTART`, `RU SYSTEM`, so it survives
reboots — but its hostname changes, so `LKG_URL` must be updated after each start.

## 11. First user (prescribed) + device registration

"Build from the ground up assuming I am the first user" = one prescribed account
exists in the database before any device appears, and every device that launches
the app recovers into it.

Prescription (`src/bootstrap.ts`, `DEFAULT_FIRST_USER`):

| object | id | notes |
|---|---|---|
| actor | `actor-mo-0001` / `account-mo-0001` | `display_name = mo-motionmix`; roles `[organizer, participant, viewer]` |
| series | `series-mo-0001` | "Motion Mix Sessions", organized by the actor |
| sphere | `sphere-mo-studio` | "Studio", under that series |
| subscription | `sub-actor-mo-0001-series-mo-0001` | actor subscribed to its own series |

`display_name` is load-bearing: `complete_actor_recovery` matches an existing
actor by `display_name == accountHint`, and the app's default hint is
`participation.dev.actorID = mo-motionmix`. That is the whole reason N devices
converge on one actor.

Two ways the prescription lands:
- **CLI / clean re-apply** — `npx tsx tools/bootstrap.ts --sql --reset | bash tools/d1-apply.sh`
  (17 `DELETE`s on the derived tables, never the 12 consent instruments, then the
  4 idempotent upserts). Applied to the live `participation` D1 this session.
- **Worker boot** — `ensureFirstUser(db)` runs alongside `seedInstruments(db)`:
  it prescribes only when the actors table has **zero** rows, so it can never
  overwrite a live account. Same call in `src/dev-server.ts` for local parity.

`tools/d1-apply.sh` is required because `wrangler d1 execute --file` returns
`{"D1_RESET_DO":true}` on this database; the script runs each rendered statement
through `--command` in turn.

Device registration is unchanged and already correct: each iPhone keeps its own
P-256 key (`ParticipationDeviceKeyStore`) and its own device session, resolves
its actor server-side, and recovers with the shared hint. Verified live against
the deployed Worker with `tools/recover-first-user.ts` (two fresh device keys →
both `actor-mo-0001`, distinct `deviceSessionID`s, prescribed series/sphere/sub
visible in `load_home`).

Post-reset live D1 state: actors 1, devices 0, series 1, spheres 1, subs 1,
consent_instruments 12 — the iPhones are the first real devices to register.

Watch: Apple Watch is explicitly out of scope for now (its install errors 4000);
the iPad Pro 12.9 is locked and will be re-attempted by Mo.

## 12. Recovery contract: the challenge carries a real device session

`ParticipationStore.recoverActor()` (iOS) enforces, after `complete_actor_recovery`:

```swift
guard actor.deviceSessionID == challenge.deviceSessionID else { throw .integrityFailure }
```

So `begin_actor_recovery` must open the device session up front and challenge
against it, and `complete_actor_recovery` must **bind that same row**, never mint
a new one. An earlier revision passed the literal `"pending"` as the challenge's
`deviceSessionID`; the server completed successfully but the client threw
`integrityFailure`, which the store reports as the notice **"Participation
unavailable"** even though the device was already bound server-side.

Correct shape (mirrors `begin_admission` / `complete_admission`):

```
begin_actor_recovery    -> const dsid = await newDeviceSession(db, null, deviceKey.keyID, now)
                           issueChallenge(db, "account_recovery", subject, dsid, ...)
complete_actor_recovery -> const ch = SELECT * FROM challenges WHERE challenge_id = proof.challengeID
                           const dsid = ch.device_session_id
                           UPDATE device_sessions SET actor_id=? WHERE device_session_id=?
```

Regression coverage:
- `test/bootstrap.test.ts` — "complete_actor_recovery returns the same
  deviceSessionID the challenge carried (no 'pending' placeholder)".
- `tools/recover-first-user.ts` — on-wire proof against the deployed Worker
  ("challenge deviceSessionID is real", "returned deviceSessionID equals the
  challenge's").

App-side companion fix: `ParticipationStore.protectTransientState()` re-seeds
`recoveryAccountHint = defaultAccountHint` instead of blanking it, because
`open(.home)` calls that reset before the Recovery screen is shown — blanking it
left the pre-filled `mo-motionmix` hint empty on first open.

## 13. v2 security core (2026-10-22)

Security review C1 (anyone on the internet could become an existing actor) and
its neighbours are closed in code, not by the kill switch. The wire shape of the
19 v1 operations is unchanged; three operations are added and two payloads gain
a field. `/health` reports `protocol: 2`.

| Rule | Where | Wire effect |
|---|---|---|
| Device keys are insert-only; `keyID` must be `sha256(pub)`; a second registration must present the same bytes | `security.ts registerDeviceInsertOnly` | `key_id_mismatch`, `device_key_conflict` |
| A bearer may only introduce the key it was minted for | `requireOwnKey` (token `dk`) | `key_not_bearer` |
| Recovery needs a single-use, short-lived **grant**; the account hint is a label, never a lookup | `recovery_grants`, `begin_actor_recovery { recoverySecret }` | `recovery_grant_required / _invalid / _consumed / _expired`, `device_bound_elsewhere` |
| A bound device vouches for the next one | `issue_recovery_grant {}` → `{ recoverySecret, expiresAt }` (show as QR) | new op |
| The operator issues a grant when no bound device is at hand | `POST /participation/v1/operator/recovery-grant { actorID }` with the operator bearer (server stores `OPERATOR_BEARER_SHA256`) | new route; `tools/operator-grant.ts` |
| Admission needs a server-issued **invitation**; scopes come from it; the organizer mints it | `create_invitation { sphereID, role, scopes?, maxUses?, ttlSeconds? }` → `{ reference, url, grantedScopes, expiresAt }`; `revoke_invitation { invitationID }` | new ops; `begin_admission` returns `unknown_invitation / invitation_expired / _exhausted / _revoked / role_mismatch` |
| A guest with no actor gets one at admission, with exactly the invited role | `complete_admission` | guest `actorID` ≠ organizer |
| A receipt is checked against the authenticated principal and the stored session | `requireMembership` | `membership_not_yours`, `receipt_mismatch` |
| The handoff exchange is the one path that binds the full app's new key; resume requires a bound key | `exchange_full_app_handoff`, `resume_full_app_session` | `actor_mismatch` |
| Organizer objects need an actor with the organizer role | `requireActor` | `actor_required`, `role_denied` |
| Every mutation leaves an audit row | `audit_log` | — |
| Expired nonces, challenges, grants are collected hourly | `scheduled` + `[triggers] crons` | — |

Schema: `migrations/0002_v2_security_core.sql` (two tables, three columns).
Tests: `npm test` (53) and `npm run smoke` (HTTP, real issuer, operator route).
Live D1 cleanup of bring-up residue: `tools/collapse-stray-actors.ts` prints the
reviewed SQL; it is applied through a gated, receipted step, never from a shell.

**App consequences (build 130+, work item 3):** send `recoverySecret` on
recovery (scanned from a sibling's QR or an operator QR); an Organizer "Invite"
screen that calls `create_invitation` and shows `url` as a QR; the App Clip uses
the invitation reference from the link exactly as today. Phones on build 127
keep working for `load_home`, consent and sources with their existing receipts;
they cannot recover or join until rebuilt, which is the intended state.
