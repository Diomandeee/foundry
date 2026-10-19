# S1 contrarian challenge

Reviewer: Lagrange, agent 01a14ff1-90ec-7212-bf09-e6a76360b088. Source advisory, not gate approval.

1. MEDIUM: source-copy fit estimate assumes maximal directory count; 8,192 empty flat files can be rejected on a 256 MiB image. Disposition: retain and explicitly document conservative admission, not an exact capacity estimate. No automatic image enlargement.
2. MEDIUM: root filesystem had bytes but no inode-headroom check. Repair: check both bytes and available inodes before durable slot creation for all recipes; work filesystem checked separately after format.
3. LOW: indexed native collision guard lost original directory spelling. Repair: bounded casefold-to-original component map, matching ProjectInputPaths semantics.
4. LOW: failed seal/containment lacked classified durable failure context. Repair: best-effort fixed operation codes and actual containment/capture booleans; no exception text or untrusted values, no success on missing journal evidence.

Challenge also confirmed source requests a global ext4 remount and checks superblock ro options, rather than only bind flags. Actual cgroup domain/kill/freeze/events checks precede launch. AppArmor policy provenance needed separate completion and review. These conclusions do not prove runtime behavior.
