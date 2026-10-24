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
