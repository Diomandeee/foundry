#!/bin/bash
# End-to-end test of fleet-authority 1.2 <-> fleet-signal, no root needed.
# Runs a test-mode daemon on this Mac, enrolls a throwaway node + phone key at the
# relay, stages a request with tricky characters, approves it from the stand-in
# phone (test/fabric-device.mjs), then checks deny, replay, forged signature and
# receipt mirroring. Revokes the throwaway identities at the end.
#
# Usage: test/fabric-e2e.sh [relay-url]   (owner bearer read from
#        ~/.config/foundry/fleet-signal-staging/owner-bearer, never printed)
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
R=${1:-https://fleet-signal-staging.motionmix-participation.workers.dev}
T=/private/tmp/fa-e2e-$$          # short: unix socket paths are capped at 104 bytes
DEV=$(mktemp -d); H=e2e$(date +%H%M%S); BEARER_FILE=~/.config/foundry/fleet-signal-staging/owner-bearer
fail() { echo "FAIL: $*"; exit 1; }
admin() { curl -sf -X POST "$R/v1/admin/$1" -H "authorization: Bearer $(cat "$BEARER_FILE")" -H 'content-type: application/json' -d "$2" >/dev/null; }
cleanup() {
  pkill -f "$T/bin/fleet-authority daemon" 2>/dev/null || true
  admin revoke "{\"kind\":\"node\",\"id\":\"$H-node\"}" || true
  admin revoke "{\"kind\":\"device\",\"id\":\"$H-phone\"}" || true
  rm -rf "$T" "$DEV"
}
trap cleanup EXIT
phone() { RELAY=$R DEVDIR=$DEV node "$HERE/test/fabric-device.mjs" "$@"; }

mkdir -p $T/{bin,pending,log,templates}; chmod 700 $T
swiftc -O "$HERE/FleetAuthority.swift" -o $T/bin/fleet-authority 2>&1 | grep error && fail build
chmod 755 $T/bin/fleet-authority
python3 -c "
import json,hashlib
json.dump({'v':1,'host':'$H','approver_uids':[$(id -u)],'expiry_s':1800,'default_tier':3},open('$T/policy.json','w'))
json.dump({'binary_sha256':hashlib.sha256(open('$T/bin/fleet-authority','rb').read()).hexdigest()},open('$T/install-receipt.json','w'))"
chmod 644 $T/policy.json $T/install-receipt.json
export FLEET_AUTHORITY_TEST_ROOT=$T
FA=$T/bin/fleet-authority
($FA daemon > $T/daemon.log 2>&1 &); sleep 2
NODE=$($FA node-key); [ -n "$NODE" ] || fail "no node key"
DEVSPKI=$(phone keygen)
admin nodes "{\"node_id\":\"$H-node\",\"host\":\"$H\",\"spki\":\"$NODE\"}" || fail "enroll node"
admin devices "{\"device_id\":\"$H-phone\",\"spki\":\"$DEVSPKI\",\"decision_spki\":\"$DEVSPKI\",\"biometric\":true,\"label\":\"e2e\"}" || fail "enroll device"
$FA keys-add $H-phone "$DEVSPKI" e2e --biometric >/dev/null
$FA relay-config "$R" $H-node >/dev/null

id_of() { python3 -c "import sys,json;print(json.load(sys.stdin)['request_id'])"; }
printf 'echo "from attachment: $1"\n' > $DEV/helper.sh
A=$(printf 'echo "fabric e2e: café ✓"\t# tab\necho back\\\\slash \x27quote\x27\nbash "$FLEET_FILES/helper.sh" yes\n' | $FA stage "e2e approve" --attach helper.sh=$DEV/helper.sh | id_of)
# Enrolling another key while A is pending must not kill A (keys.json is outside the policy hash).
K2=$(node -e "const {webcrypto:c}=require('node:crypto');c.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign']).then(k=>c.subtle.exportKey('spki',k.publicKey)).then(b=>console.log(Buffer.from(b).toString('base64')))")
$FA keys-add spare "$K2" --biometric >/dev/null
D=$(echo 'echo must-not-run' | $FA stage "e2e deny" | id_of)
sleep 22   # one idle relay tick publishes both

OUT=$(phone decide $H-phone $H $A approve "$NODE"); grep -q 'node signature valid: true | fp recomputed matches: true' <<<"$OUT" || fail "phone could not verify A: $OUT"
phone decide $H-phone $H $D deny "$NODE" >/dev/null
OUT=$(phone decide $H-phone $H $D approve "$NODE" || true); grep -q already-decided <<<"$OUT" || fail "replay not refused: $OUT"
sleep 8
grep -q 'fabric e2e: café ✓' $T/log/$A.out || fail "A did not run"
grep -q 'from attachment: yes' $T/log/$A.out || fail "A attachment did not run"
[ ! -e $T/log/$D.out ] || fail "denied request ran"
python3 - "$T" "$H" "$D" <<'EOF' || fail "forged signature accepted"
import json,socket,sys,time,base64
T,H,ID=sys.argv[1:]
s=socket.socket(socket.AF_UNIX); s.connect(f"{T}/fleet-authority.sock")
s.sendall(json.dumps({"op":"approve_signed","message":json.dumps({"v":1,"host":H,"request_id":ID,"issued_at":int(time.time())}),
  "signature":base64.b64encode(b"\x30\x06\x02\x01\x01\x02\x01\x01").decode(),"key_id":"spare"}).encode()+b"\n")
sys.exit(0 if json.loads(s.recv(4096))["ok"] is False else 1)
EOF
for i in $(seq 1 15); do   # idle relay ticks are 20 s apart; wait for the mirror to catch up
  $FA status | python3 -c "
import sys,json; d=json.load(sys.stdin); st=d['relay_state']
sys.exit(0 if st.get('receipts_mirrored')==d['receipts'] else 1)" && break
  [ $i = 15 ] && fail "receipt mirror never caught up"; sleep 3
done
echo "PASS: publish, phone verify, approve ran once, deny, replay refused, forged refused, receipts mirrored ($($FA status | python3 -c 'import sys,json;print(json.load(sys.stdin)["receipts"])'))"
