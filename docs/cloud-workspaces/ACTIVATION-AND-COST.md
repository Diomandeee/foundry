# Activation proposal and cost gate

Nothing here is an executable deployment or granted permission. `RESOURCE-PROPOSAL.json` specifies the one proposed Linux host. Cloudflare remains the compute authority; existing DigitalOcean services are not migrated.

## Cost evidence and pilot duration

Google's current public general-purpose pricing table lists an on-demand E2 standard-2 reference of $0.06701142/hour. This is an indicative public rate, **not a project/zone billing quote**: the page has region selection, and account currency, SKU, taxes and effective rates must be checked at approval. At that reference rate, 168 running hours would cost about $11.26 in compute, excluding disks, networking, object operations, logging and taxes. There is no committed-use discount or spot assumption.

- [Google general-purpose pricing](https://cloud.google.com/products/compute/pricing/general-purpose)
- [Disk/image pricing](https://cloud.google.com/compute/disks-image-pricing)
- [Free-trial terms](https://cloud.google.com/signup-faqs)

Propose a seven-day initial pilot within a separately approved $50 envelope. The 130 GiB of proposed provisioned disks is billed independently of VM runtime; object storage/egress and any external IP or NAT are additional. No total is represented as a verified quote. Review those line items and remaining credit expiry immediately before approval. The owner confirms signing up for $300; this session has not queried billing balance. Credits do not remove spending gates. Budget alerts are not a hard cap.

## Network and identity prerequisites

A private-only VM needs an approved egress route to install/connect Tailscale, fetch dependencies and reach Cloudflare/broker endpoints. Do not assume an existing Cloud NAT/router or provision one invisibly. The exact egress choice is an explicit infrastructure approval item: existing approved egress, or an approved outbound-capable ephemeral external address with no public app/SSH ingress. The latter is connectivity, not publication. No network change was made.

Device identities use opaque references selected by trusted hosts. Operator credentials are not copied to the VM/Macs. A dedicated VM identity and broker/verifier grants require reviewed IAM and issuance. `BUILD_BROKER_CREDENTIAL` is a proposed server secret binding name only; no value was generated, read or changed. `COMPUTE_BUILDS_ENABLED` stays unset/false. Existing credentials and stock Codex login are untouched.

Broker namespaces retain immutable budgets/replay/tombstones. Chunk packaging does not enlarge an existing broker's lifetime budget. A publication plan must allocate reviewed durable namespaces and actual grants before claiming large archives can be delivered. No history is pruned or reset to create capacity. The broker grant observer must distinguish build jobs from legacy exact-output jobs and refresh real authority state before and after provider I/O.

## Required rollout receipts

1. Current source hashes and inherited HOLD register; explicit validation authorization.
2. Current resource quote, credit balance/expiry, network decision, resource labels, exact image, permissions and $50 envelope approval.
3. Separate provisioning/installation/secret-reference approvals and receipts. No bootstrap script is run automatically.
4. Validated catalog publication generation/hash and first-client restore receipt; then remaining clients.
5. Linux worker identity, profile/image digest, filesystem roots, network policy, host stop proof and one accepted job.
6. Approved Mac space recovery; dedicated account/roots/toolchain/containment; one accepted unsigned build before another Mac.

## Stop, rollback and recovery

Disable new build admission first; cancellation requests do not prove termination. Drain or quarantine active attempts and preserve journal/stop evidence. Keep retained slots until actual stop observation or explicit owner reconciliation. Disable the new route only after assessing active leases; do not destroy Durable Object state or roll back its additive tables. Keep the legacy gate/compute routes intact.

Stop the VM only with the matching approval. Preserve its disks and durable broker state; stopping the VM does not stop disk/object charges. Do not delete original projects, cloud generations, identities, release archives or attempt history as rollback. Restore a compatible host from pinned source and policy receipts; ambiguous attempts remain quarantined and never replay automatically.

## Exact gate

Source implementation/review precedes runtime evidence. Tests, trial restores/builds, daemon starts, provisioning, installation, new cloud writes/reads with spend, secret changes, merges, deployment and cleanup await explicit approval. Local metadata/hash/receipt preparation does not satisfy any operational gate.
