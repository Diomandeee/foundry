#!/bin/bash
# Deliver an already-intaken Foundry build (no rebuild). Used when intake succeeded but delivery failed
# (2026-10-22: delivery read files/ while verified intake stores payload/). Requires the root intake receipt.
#   deliver-intake.sh <attempt-id>
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
ATT=${1:?attempt id}
[[ $ATT =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { echo "bad attempt id"; exit 2; }
VM=/Library/Foundry/VM; BASE=$VM/attempts/$ATT; T=$BASE/io-intake/tree; EVIDENCE=intake
[ -f "$BASE/receipts/intake.json" ] || { echo "REFUSED: no root intake receipt for $ATT"; exit 1; }
[ -f "$T/result.json" ] || { echo "REFUSED: no intake tree for $ATT"; exit 1; }
OUTD=/Volumes/FoundryBuild/staging/results/$ATT
# A failed delivery left a partial, root-owned copy; it is rebuilt from the verified tree below.
[ -d "$OUTD" ] && { echo "removing partial delivery $OUTD"; rm -rf "$OUTD"; }
/usr/bin/python3 -I - "$T" "$OUTD" "$BASE" "$EVIDENCE" <<'PY'
import hashlib, json, os, shutil, sys, time
tree, outd, base, evidence = sys.argv[1:5]
rec = []
# mac-vm-io intake writes the guest's files/ under payload/ (and build.log as payload/.foundry-vm.log);
# the diagnostic raw mount keeps files/. Read from whichever this tree has.
pdir = 'payload' if os.path.isdir(os.path.join(tree, 'payload')) else 'files'
r = json.load(open(os.path.join(tree, 'result.json')))
if r.get('exitCode') != 0 or r.get('limited'):
    print('build did not succeed; nothing delivered'); sys.exit(0)
os.makedirs(outd, exist_ok=False)
for d in r.get('directories', []): os.makedirs(os.path.join(outd, 'files', d), exist_ok=True)
for o in r['outputs']:
    src = os.path.join(tree, pdir, o['path']); dst = os.path.join(outd, 'files', o['path'])
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    h = hashlib.sha256()
    with open(src, 'rb') as f, open(dst, 'xb') as g:
        for b in iter(lambda: f.read(8 << 20), b''): h.update(b); g.write(b)
    assert h.hexdigest() == o['sha256'] and os.path.getsize(dst) == o['sizeBytes'], o['path']
    os.chmod(dst, 0o755 if o['mode'] == 0o755 else 0o644)
    rec.append({'path': o['path'], 'sha256': h.hexdigest(), 'bytes': os.path.getsize(dst), 'mode': o['mode']})
shutil.copyfile(os.path.join(tree, 'result.json'), os.path.join(outd, 'result.json'))
# Review H8: the delivered tree (and its result.json) end up owned by the login user, so they cannot vouch for
# themselves. This receipt is computed by root from the root-mounted intake tree, lives in the root-owned
# attempt dir, and is what Mac1 must verify the delivered files against.
with open(os.path.join(tree, 'result.json'), 'rb') as f: rsha = hashlib.sha256(f.read()).hexdigest()
receipt = {'version': 1, 'kind': 'delivered-outputs', 'attempt': os.path.basename(base), 'evidence': evidence,
           'resultJsonSha256': rsha, 'outputs': sorted(rec, key=lambda e: e['path']),
           'deliveredTo': outd, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
rp = os.path.join(base, 'receipts', 'outputs.json')
with open(rp + '.tmp', 'x') as f: json.dump(receipt, f, sort_keys=True, separators=(',', ':'))
os.chown(rp + '.tmp', 0, 0); os.chmod(rp + '.tmp', 0o444); os.rename(rp + '.tmp', rp)
print('root receipt', rp, hashlib.sha256(open(rp, 'rb').read()).hexdigest())
for root, dirs, names in os.walk(outd):
    for n in dirs + names: os.chown(os.path.join(root, n), 501, 20)
os.chown(outd, 501, 20)
print('delivered', len(r['outputs']), 'files,', sum(o['sizeBytes'] for o in r['outputs']), 'bytes to', outd)
PY
echo "== deliver-intake $ATT done"
