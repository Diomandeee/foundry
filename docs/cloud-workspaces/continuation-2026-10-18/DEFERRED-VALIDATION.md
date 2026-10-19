# Deferred acceptance additions — NOT RUN

These are future acceptance requirements, not test code or claims of results. Execute only after matching validation approval; operational prerequisites have separate approval gates.

1. Reopen online and legacy namespaces; reject mode/namespace/schema substitution while preserving all rows.
2. Exercise heartbeat staleness then recovery without permanent tombstone; contrast actual cancellation/expiry/incarnation/credential fencing and retained verified outputs.
3. Lose a reservation reply after commit; recover the exact receipt and one debit across restart and namespace selection. Reject changed need under the same key, conflicting histories and attempted rollover from an inactive bound namespace. Permit an unrelated operation in an active member of a mixed inactive/active set.
4. Cancel before/through HTTP refresh, issue, provider I/O and cached replay. Prevent subsequent provider/credential work, preserve uncertainty and admission until physical settlement. Concurrent duplicate online calls report busy; legacy independent waiter behavior remains unchanged.
5. Lose revocation delivery replies, retry exact commands, send a new command for the same grant, and reject key/payload conflicts. Verify actual command receipts and retained local denial across failures/reopen.
6. Reconstruct v2 snapshots with packed/empty/large files, multiple pages/namespaces, exact generation hashes, cross-page aliases/collisions, gaps/overlap, missing inputs, undeclared entries, budget exhaustion and partial failure. V1 remains supported in its explicit flat staging layout.
7. Resolve namespace ports only after an actual claim; reject wrong job/input/profile/epoch/worker/incarnation/generation, mutated/rebound slots and context lookalikes. Never expose raw capabilities or owner/provider credentials.
8. Apply the tighter input cap before source hydration; reject mismatched root hash/ref even at equal byte length; independently inspect actual npm/cargo working-source bytes and extra files as well as immutable input.
9. Check empty regular outputs and actual tar framing. Manifest overhead admission precedes provider writes and staging shares the same receipt.
10. Native source must continue to deny placement and retain unknown/quarantine. Process-only ES evidence, missing/gapped/replaced journals, signatures or empty process sets must never release a slot. Do not run a native trial until full containment and physical launch fencing are implemented and reviewed.

No tests, compilation, imports/probes, trial restores/builds, services, installation, provider operations or cleanup were performed in this batch. The full R6/R7 acceptance protocol remains in the parent documentation.
