#!/bin/bash
# Enroll a Fabric phone: relay first (owner bearer, no tap), then stage `keys-add` on each Mac
# (one approval per Mac: that tap is Mohamed confirming the phone on that Mac).
#
#   enroll-phone.sh '<fabric-enroll:... code from the app>' [mac5 mac4 mac1 ...]
#   RELAY=<url> (default staging)   DRY=1 prints what it would do.
#
# keys.json sits outside the policy hash (fleet-authority 1.2+), so pending requests survive.
set -euo pipefail
CODE=${1:?usage: enroll-phone.sh <fabric-enroll:code> [hosts...]}; shift
HOSTS=${*:-mac5}
RELAY=${RELAY:-https://fleet-signal-staging.motionmix-participation.workers.dev}
BEARER_FILE=~/.config/foundry/fleet-signal-staging/owner-bearer
J=$(python3 - "$CODE" <<'EOF'
import sys,json,base64
c=sys.argv[1]; assert c.startswith("fabric-enroll:"), "not a Fabric enrollment code"
o=json.loads(base64.b64decode(c.split(":",1)[1]))
assert o.get("v")==1 and o["device_id"] and o["auth_spki"] and o["decision_spki"]
print(json.dumps(o))
EOF
)
get() { python3 -c "import sys,json;print(json.loads(sys.argv[1])[sys.argv[2]])" "$J" "$1"; }
DEV=$(get device_id); AUTH=$(get auth_spki); DEC=$(get decision_spki); SE=$(get secure_enclave)
FP=$(python3 -c "import sys,base64,hashlib;h=hashlib.sha256(base64.b64decode(sys.argv[1])).hexdigest()[:16];print(' '.join(h[i:i+4] for i in range(0,16,4)))" "$DEC")
echo "phone $DEV  decision key $FP  secure_enclave=$SE"
[ "$SE" = "True" ] || [ "${ALLOW_SOFTWARE_KEY:-}" = 1 ] || { echo "REFUSED: decision key is not in a Secure Enclave (Simulator?). Set ALLOW_SOFTWARE_KEY=1 for tests only."; exit 1; }
[ -n "${DRY:-}" ] && { echo "DRY: would enroll at $RELAY and stage keys-add on: $HOSTS"; exit 0; }

BODY=$(python3 -c "import json,sys;print(json.dumps({'device_id':sys.argv[1],'spki':sys.argv[2],'decision_spki':sys.argv[3],'label':'Fabric '+sys.argv[1]}))" "$DEV" "$AUTH" "$DEC")
curl -sf -X POST "$RELAY/v1/admin/devices" -H "authorization: Bearer $(cat "$BEARER_FILE")" -H 'content-type: application/json' -d "$BODY" >/dev/null \
  && echo "relay: enrolled $DEV" || echo "relay: enroll failed (already enrolled?)"

for H in $HOSTS; do
  SCRIPT="set -euo pipefail
/Library/FleetAuthority/bin/fleet-authority keys-add '$DEV' '$DEC' 'Fabric phone (decision key $FP)'"
  case $H in
    mac1) RUN=(bash -c) ;;
    mac5) RUN=(ssh -o ConnectTimeout=8 -o HostKeyAlias=mac5 -i ~/.ssh/id_mac5_auto mohameddiomande@mac5.local) ;;
    *)    RUN=(ssh -o ConnectTimeout=8 "$H-lan") ;;
  esac
  OUT=$(printf '%s\n' "$SCRIPT" | "${RUN[@]}" "/Library/FleetAuthority/bin/fleet-authority stage 'Enroll Fabric phone $DEV on this Mac: its Face ID decision key ($FP) may approve root requests here. Adds one line to keys.json; pending requests are unaffected. Deletes nothing.'" 2>&1 || true)
  echo "$H: $(echo "$OUT" | python3 -c "import sys,json
try:
  d=json.load(sys.stdin); print('staged '+d['request_id'] if d.get('ok') else 'refused '+str(d.get('refused')))
except Exception: print('stage failed')")"
done
