#!/bin/bash
# Stage the three Foundry build requests on Mac5 (needs fleet-authority 1.4 there for --attach). Prints request ids.
#   stage.sh [1|2|3 ...]   (default: all)
set -euo pipefail
cd "$(dirname "$0")"
M5=(ssh -o ConnectTimeout=10 -o HostKeyAlias=mac5 -i "$HOME/.ssh/id_mac5_auto" mohameddiomande@mac5.local)
W=/tmp/foundry-req-$$
"${M5[@]}" "mkdir -m 700 $W"
scp -q -o HostKeyAlias=mac5 -i "$HOME/.ssh/id_mac5_auto" build-job.sh seal-capability-v5.sh foundry-*.sh "mohameddiomande@mac5.local:$W/"
desc() { case $1 in
  1) echo "Foundry build 1/3: seal VM capability v5, then build Mo en Movimiento (Debug) in the no-network VM. Attached scripts only, nothing from /Users runs. Deletes nothing.";;
  2) echo "Foundry build 2/3: build Air Deck (Debug) in the no-network VM. Attached scripts only. Deletes nothing.";;
  3) echo "Foundry build 3/3: build Coltivare (Release) in the no-network VM. Attached scripts only. Deletes nothing.";; esac; }
for n in ${*:-1 2 3}; do
  f=$(ls foundry-$n-*.sh); att="--attach build-job.sh=$W/build-job.sh"
  [ "$n" = 1 ] && att="$att --attach seal-capability-v5.sh=$W/seal-capability-v5.sh"
  "${M5[@]}" "/Library/FleetAuthority/bin/fleet-authority stage '$(desc $n)' --timeout 3600 $att < $W/$f" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print('$f', d.get('request_id') or d.get('refused'))"
done
"${M5[@]}" "rm -f $W/*.sh; rmdir $W"
