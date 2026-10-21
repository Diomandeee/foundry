// Phase 2 keying helper for the Linux build host. Takes one owner recipe file
// ({profile: BuildProfile, localPolicy: LocalRecipePolicy, maxInputBytes}) and
// prints the two hashes the fleet uses for it plus the exact broker profile the
// controller will demand back from policy.json:
//
//   node_modules/.bin/tsx tools/foundry-linux-host/recipe-digests.ts recipe.json
//
// serverProfileHash = sha256(canonical BuildProfile)   (what the compute authority stores)
// localRecipeHash   = profileDigest(approval)          (policy.json profile key, claim policy)
// brokerProfile     = linuxIsolationProfile(binding)   (write-policy.py --profile input)
// Pure computation: nothing is installed, deployed or sent anywhere.
import { readFileSync } from 'node:fs';
import { approveParentProfile, canonicalData, type LocalRecipePolicy } from '../../packages/build-runtime/src/parent-profile.js';
import { linuxIsolationProfile } from '../../packages/build-runtime/src/linux-isolated-adapter.js';
import { hash } from '../../packages/build-runtime/src/plans.js';
import type { BuildProfile } from '../../packages/build-jobs/src/contracts.js';

const file = process.argv[2];
if (!file || !file.endsWith('.json')) { process.stderr.write('usage: recipe-digests.ts recipe.json\n'); process.exit(2); }
const owner = JSON.parse(readFileSync(file, 'utf8')) as { profile: BuildProfile; localPolicy: LocalRecipePolicy; maxInputBytes: number };
const serverProfileHash = hash(canonicalData(owner.profile));
const binding = approveParentProfile(owner.profile, serverProfileHash, owner.localPolicy);
const brokerProfile = linuxIsolationProfile(binding, owner.maxInputBytes);
process.stdout.write(JSON.stringify({ serverProfileHash, localRecipeHash: binding.localRecipeHash, maxInputBytes: owner.maxInputBytes, brokerProfile }, null, 1) + '\n');
