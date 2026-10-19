# Guest IO assignment status

User authorization: finish M1/M2 local implementation, source review and route update; tests and operations stay gated.

- M1 IMPLEMENTED / SOURCE-REVIEWED / VALIDATION-PENDING: exact snapshot/object/tree verification, privately branded job/stage, concrete create-only root image assembler, actual staged acceptance and guarded launch lifetime.
- M2 IMPLEMENTED / SOURCE-REVIEWED / VALIDATION-PENDING: actual started/stopped binding, immutable raw copy and readonly extraction, guest v2 tree/lineage verification, real immutable publication composition and independent returned-byte checks.
- REVIEW COMPLETE FOR SOURCE SCOPE: six inline passes, repairs and scoped diff/hash receipt. No independent-review, compile or runtime claim.
- M3 OPEN: production adapter/controller/capability and authority submission/reconciliation; generic writable isolation/inherited HOLD remain.
- M4/R7 GATED: tests, compilation/import/probes, installation, image/mount/helper/VM/service operations, provider/spend/secrets/Git integration/deploy/cleanup.

Exact stop: R6-guest-io-source-reviewed-HOLD. No agents, background jobs or operations dispatched. Protected session history untouched. See README.md, SOURCE-REVIEW.md, FINDINGS.json, CHANGE-RECEIPT.json and ../ROUTE.json.
