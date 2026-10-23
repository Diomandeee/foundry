#!/bin/bash
# fleet-authority 1.3 hardening checks (security review 2026-10-22), test mode, no root, no network.
set -eu  # no pipefail: several checks grep the output of a command that is expected to refuse (exit 1)
HERE=$(cd "$(dirname "$0")/.." && pwd)
T=/private/tmp/fa-h13-$$; mkdir -p $T/{bin,pending,log,templates}; chmod 700 $T
trap 'pkill -f "$T/bin/fleet-authority daemon" 2>/dev/null || true; rm -rf "$T"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "ok   $*"; }
swiftc -O "$HERE/FleetAuthority.swift" -o $T/bin/fleet-authority 2>&1 | grep error && fail build
chmod 755 $T/bin/fleet-authority
python3 -c "
import json,hashlib
json.dump({'v':1,'host':'h13','approver_uids':[$(id -u)],'expiry_s':1800,'default_tier':3},open('$T/policy.json','w'))
json.dump({'binary_sha256':hashlib.sha256(open('$T/bin/fleet-authority','rb').read()).hexdigest()},open('$T/install-receipt.json','w'))"
chmod 644 $T/policy.json $T/install-receipt.json
export FLEET_AUTHORITY_TEST_ROOT=$T; FA=$T/bin/fleet-authority
($FA daemon > $T/daemon.log 2>&1 &); sleep 2
sock() { python3 - "$T/fleet-authority.sock" "$1" <<'EOF'
import json,socket,sys
s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); s.sendall(sys.argv[2].encode()+b"\n")
b=b""
while True:
    c=s.recv(65536)
    if not c: break
    b+=c
print(b.decode().strip())
EOF
}
stage() { sock "$(python3 -c 'import json,sys;print(json.dumps({"op":"stage","description":sys.argv[1],"script":sys.argv[2]}))' "$1" "$2")"; }
idof() { python3 -c "import sys,json;print(json.load(sys.stdin)['request_id'])"; }

# H1: PATH has no /opt/homebrew/bin
ID=$(stage "path probe" 'echo "$PATH"' | idof); $FA show $ID >/dev/null; $FA approve $ID >/dev/null || true
grep -qx '/usr/bin:/bin:/usr/sbin:/sbin' $T/log/$ID.out && pass "H1 root PATH is system-only" || fail "H1 PATH: $(cat $T/log/$ID.out)"

# M2: short ids refused, full id works
ID=$(stage "id probe" 'echo hi' | idof); $FA show $ID >/dev/null
$FA approve ${ID:0:8} | grep -q identifier-too-short && pass "M2 8-hex prefix refused" || fail "M2 short id accepted"
$FA approve $ID | grep -q "APPROVED and ran" && pass "M2 full id approves" || fail "M2 full id"

# M1: control / bidi characters refused in description and script
stage "$(printf 'fine\033[2Jfake')" 'echo x' | grep -q description-has-control && pass "M1 ANSI in description refused" || fail "M1 desc"
stage "bidi" "$(printf 'echo a \xe2\x80\xae evil')" | grep -q script-has-control && pass "M1 bidi override in script refused" || fail "M1 script"

# C2 render: unpinned references flagged
ID=$(stage "launcher" 'bash ~/.foundry-obs/build-job.sh' | idof)
$FA show $ID | grep -q "WARNING UNPINNED" && pass "C2 render flags user-owned paths" || fail "C2 render"
$FA show $ID | grep -q -- "---- begin $ID ----" && pass "M1 render fenced with request id" || fail "M1 fence"

# C4: free-form protected change refused; typed enroll renders the daemon's fingerprint
stage "sneaky" "/Library/FleetAuthority/bin/fleet-authority keys-add x AAAA" | grep -q protected-change-needs-typed-op && pass "C4 free-form keys-add refused" || fail "C4 free-form"
stage "sneaky2" "echo k >> /etc/ssh/fleet_authorized_keys" | grep -q protected-change-needs-typed-op && pass "C4 authorized_keys edit refused" || fail "C4 ak"
SPKI=$(node -e "const {webcrypto:c}=require('node:crypto');c.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign']).then(k=>c.subtle.exportKey('spki',k.publicKey)).then(b=>console.log(Buffer.from(b).toString('base64')))")
WANT=$(python3 -c "import sys,base64,hashlib;h=hashlib.sha256(base64.b64decode(sys.argv[1])).hexdigest();print(' '.join(h[i:i+4] for i in range(0,32,4)))" "$SPKI")
$FA enroll-key phone-x "$SPKI" | grep -q enroll-refused-key-is-not-biometric && pass "C3 non-biometric enroll refused" || fail "C3 enroll gate"
EID=$($FA enroll-key phone-x "$SPKI" --biometric | idof)
$FA show $EID | grep -q "SHA256 $WANT" && pass "C4 typed enroll shows daemon fingerprint" || fail "C4 fingerprint"
$FA approve $EID >/dev/null; python3 -c "import json;k=json.load(open('$T/keys.json'))['keys'];assert any(x['id']=='phone-x' and x['biometric']=='true' for x in k)" && pass "C4 typed enroll wrote a biometric key" || fail "C4 keys.json"

# H9: a client that hangs up before the reply does not kill the daemon
for i in 1 2 3 4 5; do python3 -c "
import socket;s=socket.socket(socket.AF_UNIX);s.connect('$T/fleet-authority.sock');s.sendall(b'{\"op\":\"list\"}\n');s.close()"; done
sleep 1; $FA status | grep -q '"ok" : true' && pass "H9 survives clients hanging up (SIGPIPE)" || fail "H9 daemon died"

# 1.4 attachments (review C2): exact bytes travel with the request; the script uses $FLEET_FILES
printf 'echo "from the attachment: $1"\n' > $T/helper.sh
ID=$($FA stage "attachment run" --attach helper.sh=$T/helper.sh <<<'bash "$FLEET_FILES/helper.sh" ok' | idof)
$FA show $ID | grep -q "attached file \$FLEET_FILES/helper.sh" && $FA show $ID | grep -q 'from the attachment' && pass "C2 render shows attached file contents" || fail "C2 attach render"
$FA approve $ID >/dev/null; grep -q "from the attachment: ok" $T/log/$ID.out && pass "C2 script runs the root-only attached copy" || fail "C2 attach run: $(cat $T/log/$ID.out)"
rm -f $T/helper.sh
FP1=$(stage "fp a" 'bash "$FLEET_FILES/helper.sh"' | python3 -c "import sys,json;print(json.load(sys.stdin)['fp'])")
printf 'echo other\n' > $T/helper.sh
FP2=$($FA stage "fp b" --attach helper.sh=$T/helper.sh <<<'bash "$FLEET_FILES/helper.sh"' | python3 -c "import sys,json;print(json.load(sys.stdin)['fp'])")
[ "$FP1" != "$FP2" ] && pass "C2 attachment is part of the fingerprint" || fail "C2 fp"
ID=$($FA stage "tamper" --attach helper.sh=$T/helper.sh <<<'bash "$FLEET_FILES/helper.sh"' | idof); $FA show $ID >/dev/null
chmod 600 $T/pending/$ID/files/helper.sh; printf 'echo EVIL\n' > $T/pending/$ID/files/helper.sh; chmod 400 $T/pending/$ID/files/helper.sh
$FA approve $ID | grep -q "attachment-changed:helper.sh" && pass "C2 tampered attachment refused" || fail "C2 tamper ran"
printf '/Library/FleetAuthority/bin/fleet-authority keys-add x y\n' > $T/sneaky.sh
$FA stage "smuggle" --attach s.sh=$T/sneaky.sh <<<'bash "$FLEET_FILES/s.sh"' | grep -q protected-change-needs-typed-op && pass "C4 protected change in an attachment refused" || fail "C4 attach smuggle"
# H9: caps
for i in $(seq 1 12); do stage "flood $i" 'echo x' >/dev/null; done
stage "flood 13" 'echo x' | grep -q too-many-pending && pass "H9 per-user pending cap" || fail "H9 cap"

# H9: orphan reconciliation on restart
ID=$(sock '{"op":"list"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['pending'][0]['id'])")
python3 - "$T/pending/$ID/request.json" <<'EOF'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d['state']='running'; json.dump(d,open(p,'w'),sort_keys=True,separators=(',',':'))
EOF
pkill -f "$T/bin/fleet-authority daemon"; sleep 1; ($FA daemon >> $T/daemon.log 2>&1 &); sleep 2
grep -q '"state":"orphaned"' $T/pending/$ID/request.json && grep -q '"kind":"orphaned"' $T/log/receipts.jsonl && pass "H9 running request marked orphaned on restart" || fail "H9 orphan"
echo "PASS: fleet-authority 1.3 hardening + 1.4 attachments"
