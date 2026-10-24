# Security bulletins check, 2026-10-24 (security lane, session e7f8a95c)

Trigger: Mohamed forwarded a post about moving VPSes behind Tailscale and Cloudflare Tunnel, asked for a read of the last days' Cloudflare and Tailscale issues, and asked for tailnet lock with a controlled device in the signing path. He left the direction to the lane.

## What actually happened in the last week (primary sources)

- PHP2Shell, CVE-2026-109618 and CVE-2026-109619, disclosed 2026-10-21 with an emergency PHP release (8.5.12). Memory disclosure plus RCE through the session upload progress feature; exploitation seen in honeypots the same day; Cloudflare deployed WAF rules about nine hours before disclosure and reports millions of attempts. Found with AI assistance by two independent teams. Our exposure: none. No PHP on Mac1, Mac4, Mac5, the Pi, Mac2 or Mac3; the Foundry Workers are TypeScript on workerd.
- eMudhra intermediate certificates, private keys compromised, known 2026-10-19 17:00Z. Anyone holding the keys can mint a valid certificate for any name, so every TLS client trusting the system store is exposed to interception. Cloudflare patched its edge and clients by 10-20 and told Tunnel users to move to cloudflared 2026.10.2 or later. Tailscale bulletin TS-2026-013 (10-21): the client accepts control-plane TLS signed by anything in the host trust store; 1.104.2 ships Go 1.27.3 which distrusts the eMudhra intermediates; node-to-node WireGuard traffic was never affected.
- Cloudflare incidents 10-16, 10-20, 10-22: Access availability, a Cloudflare One Gateway identity-policy bug, and regional congestion. Availability only, no breach reported.
- Cloudflare WAF changelog 10-22: emergency managed-ruleset metadata for the PHP CVEs. OpenNext SSRF CVE-2026-3125 affects @opennextjs/cloudflare below 1.17.1 (we do not use it). Brotli CVE-2026-111497 in workerd is Cloudflare's to patch on the hosted runtime.
- No Tailscale CVE in October. TS-2026-012 (10-13) concerns apps embedding libtailscale, which we do not ship.

## Fleet versions found

| Node | Tailscale | eMudhra fix (1.104.2) | Notes |
|---|---|---|---|
| Mac1 | 1.104.2 | yes | GUI app |
| Mac4 | 1.104.1 | no, needs root | system tailscaled in /Library/Tailscale; sudo now asks for a password |
| Mac5 | 1.104.1 | no, needs root | same |
| Pi minenode | 1.104.1 | no, needs Mohamed's sudo | listens on 0.0.0.0 for 22, 1883, 3001, 9107, 9117, 9127 (LAN, behind NAT) |
| Mac2 | 1.92.3 | no, App Store update | opened the App Store page from the CLI |
| Mac3 | 1.94.1 | no, App Store update | same |
| K11 (Windows) | 1.102.2 | update ran, service restart pending | node key expires 2026-10-25 |
| foundry-node-01 | unknown | unknown | DigitalOcean droplet 192.34.62.109, built 10-15, public port 22 open, 80/443/9107 closed; no Mac holds a working key |
| muse | tsnet node | n/a | created mid-September 2026 |
| iPhones, iPads | App Store | auto | |

cloudflared on Mac1 was 2026.10.0 (built 10-05, before the fix).

## Done this session

1. cloudflared 2026.10.0 -> 2026.10.3 on Mac1 via Homebrew; `com.motionmix.listen-tunnel` restarted; connector reports 2026.10.3 on three edges; listen.brewsnbeats.com answers 200. listen.motionmix.com has no DNS record at all (the ingress rule is dead, not a security issue).
2. Tailnet lock ENABLED at ~06:30Z from Mac1 with three trusted signing keys: Mac1, Mac4, Mac5 (their `tlpub` keys are public and in the lock log). Three disablement secrets generated, none sent to Tailscale support (the point is to survive a control-plane compromise). Secrets live only in Mac1's login keychain as `tailnet-lock-disablement-1..3`; the Mac4/Mac5 keychain writes failed over SSH (keychain locked, "User interaction is not allowed"). The init output file was shredded. Verified ENABLED and signed on Mac1, Mac4, Mac5, Mac2, Mac3, K11 and the Pi; every node online before init is still online. The `lock log` shows disablement VALUES (hashes), which are public by design.
3. K11 `tailscale update --yes` ran over SSH (authenticode verified, copy installed); version still reports 1.102.2 until the service restarts.
4. Mac2/Mac3 `Tailscale update` opened the App Store page; those are App Store installs and update from there.

## Effects of tailnet lock everyone must know

- A new device cannot talk to anyone until a signing node signs it. Recipe: on the new device `tailscale lock status` shows its nodekey; on Mac1, Mac4 or Mac5 run `tailscale lock sign nodekey:<key>` (Mac4/Mac5 CLI is `/Library/Tailscale/bin/tailscale`). Auth keys can be pre-signed with `tailscale lock sign <authkey>`.
- Key expiry does not need re-signing. Logging a node out and back in creates a new node that does.
- Device approval and tailnet lock cannot both be on. Max 20 signing nodes. Rotate signing keys at most yearly.
- Disabling needs one disablement secret (Mac1 keychain) or `tailscale lock local-disable` per node as the last resort.

## Mohamed's taps (in order of payoff)

1. Copy one `tailnet-lock-disablement-*` secret from Mac1's Keychain Access into his password manager or onto paper. Today Mac1 is the single copy.
2. Tap the fleet-authority root requests for `/Library/Tailscale/bin/tailscale update --yes` on Mac4 and Mac5 once a Foundry lane queues them (the supervisor session is gone; the request goes to whichever lane owns fleet-authority now). The Pi needs his sudo password for `sudo tailscale update`.
3. foundry-node-01 (DigitalOcean): decide destroy or keep. Nothing proven depends on it (10-15 notes: "NOTHING tested", fabric R7 still HOLD). If keep: add a DO cloud firewall with no inbound rules, enable Tailscale SSH on it, add a key for Mac1. Needs the DO console.
4. K11: its node key expires 10-25. Re-authenticate on the box or disable key expiry for it in the admin console. Also restart the Tailscale service there so 1.104.x takes.
5. Mac2 and Mac3: accept the App Store Tailscale update.
6. Admin console housekeeping (needs his login, Chrome extension was not connected): remove the eight dead nodes (two "Mac", unnamed node, two claude-code-vm, old minenode, old Mac4/Mac5 entries), and confirm device approval is off (it must be, since init succeeded).

## What the forwarded post gets right for us

The fleet is already mostly built the way the post recommends: the Macs expose only Tailscale-bound ports plus Screen Sharing and AirPlay on the LAN (macOS firewall is off on Mac1, Mac4 and Mac5; Mac1 is on cellular while travelling, so that is worth turning on there), the listen service is reached only through a Cloudflare Tunnel with a path allowlist, and the Workers live on Cloudflare. The one real VPS exception is foundry-node-01's public SSH, item 3 above.

## Addendum 06:45Z: listen tunnel hardening

cloudflared URL path normalization turned on for the listen tunnel (`--disable-path-normalization=false` in `com.motionmix.listen-tunnel.plist`, backup `.bak-20261024-normalize`; the agent was booted out and bootstrapped again so the new argument applies). Public probes after the reload: `/listen` 200, `/state` 404, `/listen/../state` 404, `/%6cisten` 404, so only the allowlisted paths reach the origin and the origin's open-read endpoints stay unreachable from the internet. `POST /ingest` on the origin requires a token (motion_state_service.py). Mac1 has no passwordless sudo, so the macOS firewall stays a tap for Mohamed.

Mac2 is being moved from the App Store Tailscale to the standalone tailscaled by the UCTM Studio lane (mohameddiomande-71): Mac4's exact 1.104.1 binary, one-shot `tailscale up --hostname=mac2`, App Store node kept until the new node is signed. The security lane signs the new node from Mac1 when the lane relays the `tailscale lock sign` line. Mac3 has no owner for the same move yet.

## Addendum 06:50Z: C1 closed in production; Mac3 staged

participation-coordinator at https://participation-coordinator.motionmix-participation.workers.dev/health reports version b814866, which is the v2 repo HEAD merged through the gate on 10-23 (pc-enroll-device, pc-recovery-link). That code carries the C1 fixes from the review: insert-only device registration, operator-issued recovery grants, invitation resolution, own-key checks (ops.ts). The v1 monorepo copy was tombstoned by the supervisor (9a4d9d4). C1 is therefore closed in production; C2 landed in fleet-authority 1.4 (verified 10-23); C3 and C4 remain with whoever owns fleet-authority now.

Mac3: the same standalone-Tailscale kit the UCTM Studio lane built for Mac2 was copied Mac2 -> Mac3 directly (checksums tailscale 97c499ef…, tailscaled 677f9e24…, identical to Mac2's) and its hostname switched to mac3. Mohamed runs `sudo sh ~/tailscale-migrate/migrate.sh` on Mac3; the security lane signs the new node from Mac1 (a watcher reads /Library/Tailscale/migrate.log on Mac2 and Mac3, checks the nodekey against the control plane's record for that hostname, then signs). Services pinned to the old tailnet IPs must move: Mac3's codex agent-mesh binds 100.122.68.52.

## Addendum 07:05Z: Mac2 moved to standalone Tailscale under the lock

Mohamed ran the kit on Mac2 at 06:53Z, logged the new node in at 06:57Z; the security lane verified the nodekey against the daemon's own Self.PublicKey over SSH and signed from Mac1 at 06:59Z; phase two then retired the App Store app (archived at /Library/Tailscale/appstore-disabled/Tailscale.app.tar) and reported finished at 06:59:06Z. Mac2 is now 100.99.72.55 (hostname mac2) on tailscaled 1.104.1; the old App Store node mohameds-laptop (100.119.214.88) is offline and can be deleted in the admin console. Lesson for the watcher: a locked-out node is absent from a signing node's peer list, so the key must be verified from the new daemon itself, not from the netmap. Mac3 kit staged; its watcher runs the corrected check.

## Addendum 07:20Z: Mac3 moved to standalone Tailscale under the lock

Mohamed ran the kit on Mac3 at 07:09Z and logged the node in; the Mac1 watcher verified the nodekey against the daemon's own Self.PublicKey over SSH and signed at 07:12:19Z; phase two retired the App Store app, killed its extension, restarted tailscaled and confirmed the 100.64/10 route on utun4, finished 07:12:38Z. Mac3 is now mac3-1 at 100.112.132.19 on tailscaled 1.104.1; Screen Sharing reopened from Mac1 at the new address. Repoints done: Mac1 ~/.ssh/config (mac3, mac3-auto), Mac1 com.mohamed.codex-agent-mesh.mac1 LaunchAgent (restarted), Mac3 com.mohamed.codex-agent-mesh.mac3 bind (restarted, 7878 listening on the new address); backups kept with .bak-20261024 suffixes. Old nodes ready for deletion in the admin console: mac3 100.122.68.52 and mohameds-laptop 100.119.214.88. Mac2 still waits for Mohamed's `sudo launchctl kickstart -k system/com.fleet.tailscaled` to regain its route (UCTM Studio lane).
