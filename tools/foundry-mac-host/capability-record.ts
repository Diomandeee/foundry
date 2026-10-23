// Build the owner-accepted MacVmCapability record for one exported guest image.
//
//   node_modules/.bin/tsx tools/foundry-mac-host/capability-record.ts \
//     <guest-observation.json> <image manifest.json> <mac-vm-host sha256> <mac-tree-guard sha256>
//
// The observation is the guest's own `mac-vm-guest.py --describe-capability`
// output (kind foundry-guest-observation); the manifest is the export's
// manifest.json (boot.raw sha256). Prints {sha256, path, capability}: sha256 is
// hash(canonicalData(capability)), the same value the runtime pins
// (readMacVmCapability) and the guest job carries as guestCapabilityHash, and
// path is the sealed tree root the runtime demands for it. Pure computation.
import { readFileSync } from 'node:fs';
import { validateMacVmCapability, type MacVmCapability } from '../../packages/build-jobs/src/mac-vm-capability.js';
import { canonicalData } from '../../packages/build-runtime/src/parent-profile.js';
import { hash } from '../../packages/build-runtime/src/plans.js';

const [observationFile, manifestFile, vmHelperSha256, treeGuardSha256] = process.argv.slice(2);
if (!observationFile || !manifestFile || !/^[0-9a-f]{64}$/.test(vmHelperSha256 ?? '') || !/^[0-9a-f]{64}$/.test(treeGuardSha256 ?? '')) {
  process.stderr.write('usage: capability-record.ts observation.json manifest.json <mac-vm-host sha256> <mac-tree-guard sha256>\n');
  process.exit(2);
}
const o = JSON.parse(readFileSync(observationFile, 'utf8')) as Record<string, unknown>;
const m = JSON.parse(readFileSync(manifestFile, 'utf8')) as { schema: string; files: Record<string, { sha256: string }> };
if (o.kind !== 'foundry-guest-observation' || o.version !== 1) throw new Error('not a guest observation');
if (m.schema !== 'foundry.mac-guest-image.v1' || !/^[0-9a-f]{64}$/.test(m.files['boot.raw']?.sha256 ?? '')) throw new Error('not an image manifest');
const capability: MacVmCapability = {
  version: 1, backend: 'apple-vz-macos-v1', architecture: o.architecture as 'arm64',
  bootSha256: m.files['boot.raw'].sha256, guestRunnerSha256: o.guestRunnerSha256 as string,
  vmHelperSha256, treeGuardSha256,
  macos: o.macos as string, developerDir: o.developerDir as string, xcodeBuild: o.xcodeBuild as string, sdks: [...(o.sdks as string[])].sort(),
};
validateMacVmCapability(capability);
const sha256 = hash(canonicalData(capability));
process.stdout.write(JSON.stringify({ sha256, path: `/Library/Foundry/VM/capabilities/${sha256}`, canonical: canonicalData(capability), capability }, null, 1) + '\n');
