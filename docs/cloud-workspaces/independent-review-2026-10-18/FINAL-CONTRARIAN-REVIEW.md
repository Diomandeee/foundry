**COMMENT — diagnostics-ordering finding resolved at source level.**

[linux-isolation.py:281–295](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/native/linux-isolation.py:281) now reserves the slot, creates and syncs the private attempt directory, and creates the durable intent journal **before cgroup setup**. Subsequent constructor failures can reach the journal through the retained partial `Attempt`.

Failure to create the directory/journal itself appropriately remains best-effort; retained resources are not treated as successfully contained.

No further finding within this scope. AppArmor/user-namespace changes remain with the security reviewer. No executable validation or gate approval.
