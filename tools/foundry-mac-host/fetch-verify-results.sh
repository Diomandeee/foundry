#!/bin/bash
# Fetch a Foundry Mac VM build's delivered outputs from Mac5 and verify them against the ROOT receipt
# (review H8): /Library/Foundry/VM/attempts/<ATT>/receipts/outputs.json, written by build-job.sh as root from
# the root-mounted intake tree. The delivered tree and its result.json are owned by the login user on Mac5, so
# they are never the source of truth.
#
#   fetch-verify-results.sh <attempt-id> [dest-dir]      (dest default ~/FoundryResults/<attempt-id>)
set -euo pipefail
ATT=${1:?usage: fetch-verify-results.sh <attempt-id> [dest]}
[[ $ATT =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { echo "bad attempt id" >&2; exit 2; }
DEST=${2:-$HOME/FoundryResults/$ATT}
SSH=(ssh -o ConnectTimeout=10 -o HostKeyAlias=mac5 -i "$HOME/.ssh/id_mac5_auto" mohameddiomande@mac5.local)
R=/Library/Foundry/VM/attempts/$ATT/receipts/outputs.json
# The receipt and every directory above it must be root-owned and not writable by anyone else.
# Run under /bin/sh explicitly: Mac5's login shell is zsh, which does not word-split "set -- $s" (bug found 2026-10-22).
"${SSH[@]}" "/bin/sh -c 'for p in /Library/Foundry/VM /Library/Foundry/VM/attempts /Library/Foundry/VM/attempts/$ATT /Library/Foundry/VM/attempts/$ATT/receipts $R; do
  u=\$(stat -f %u \"\$p\") || exit 3; m=\$(stat -f %Lp \"\$p\")
  [ \"\$u\" = 0 ] || { echo \"not root-owned: \$p\" >&2; exit 3; }
  case \$m in *[2367]?|*?[2367]) echo \"group/other-writable: \$p\" >&2; exit 3;; esac
done'" || { echo "REFUSED: root receipt missing or not root-controlled" >&2; exit 1; }
mkdir -p "$DEST"
"${SSH[@]}" "cat $R" > "$DEST/outputs.root-receipt.json"
rsync -a -e "ssh -o HostKeyAlias=mac5 -i $HOME/.ssh/id_mac5_auto" "mohameddiomande@mac5.local:/Volumes/FoundryBuild/staging/results/$ATT/files/" "$DEST/files/"
python3 -I - "$DEST" <<'PY'
import hashlib, json, os, sys
dest = sys.argv[1]
r = json.load(open(os.path.join(dest, 'outputs.root-receipt.json')))
assert r.get('kind') == 'delivered-outputs', 'not a delivered-outputs receipt'
if r.get('evidence') != 'intake':
    sys.exit('REFUSED: receipt evidence is %r, not intake' % r.get('evidence'))
want = {e['path']: e for e in r['outputs']}
seen = set()
for root, _, names in os.walk(os.path.join(dest, 'files')):
    for n in names:
        rel = os.path.relpath(os.path.join(root, n), os.path.join(dest, 'files'))
        seen.add(rel)
        e = want.get(rel)
        if e is None: sys.exit('REFUSED: unexpected file ' + rel)
        h = hashlib.sha256()
        with open(os.path.join(root, n), 'rb') as f:
            for b in iter(lambda: f.read(8 << 20), b''): h.update(b)
        if h.hexdigest() != e['sha256'] or os.path.getsize(os.path.join(root, n)) != e['bytes']:
            sys.exit('REFUSED: hash/size mismatch ' + rel)
missing = set(want) - seen
if missing: sys.exit('REFUSED: missing %d files, e.g. %s' % (len(missing), sorted(missing)[0]))
print('verified %d files (%d bytes) against the root receipt for %s' % (len(want), sum(e['bytes'] for e in want.values()), r['attempt']))
PY
