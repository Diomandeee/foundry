**APPROVE — narrow source repair; original finding addressed.**

In [linux-isolated-census.ts:11](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/src/linux-isolated-census.ts:11), `continue` executes the awaited `finally` close before reopening. Three replacement collisions exhaust the budget and fail closed.

Trust remains intact: zero-link descriptors supply no accepted data; hard links still fail; ownership, permissions, `O_NOFOLLOW`, size, schema and freshness checks remain mandatory. Replacement after `stat()` leaves a valid immutable snapshot readable through its existing descriptor.

No new actionable finding. Source inspection only; no edits, tests, compilation or operations. This is not merge or activation approval.
