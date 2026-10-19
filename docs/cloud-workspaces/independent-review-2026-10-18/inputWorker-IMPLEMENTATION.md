Edited only:

- [linux-isolated-input.ts](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/src/linux-isolated-input.ts): groups each segment’s files by final object and retains that blob across intervening chunks, including shared blobs outside index zero.
- [linux-isolated-adapter.ts](/Users/mohameddiomande/Developer/foundry-integration/source/packages/build-runtime/src/linux-isolated-adapter.ts): removes the evicting last-object cache and its copies.

Source reasoning: validated non-final chunks occupy exclusive whole objects. Grouping final-object users therefore bounds reads to `1 + segments + declared objects`: at most **8,449 for 256 segments**, within the unchanged **8,705** ceiling.

Retained cache is ≤1 MiB; cache plus current object is ≤2 MiB, excluding metadata and transport encoding. Exact references, hashes, ranges, lease/abort checks, ordered `filesHash`, and `reader.finish()` remain enforced. Root protocol and budgets were unchanged.

Structure, integration, content, and journey received inline source review, including contrarian edge cases. **Compilation, execution, and deployment remain pending.** No tests were authored or run; no runtime-success claim is made.
