#!/usr/bin/env bash
# Export a stopped Tart VM into the Foundry master-image layout on the VM volume.
#
#   sudo bash export-guest-image.sh <tart-vm-name> <image-name>
#
# Writes /Library/Foundry/VM/images/<image-name>/:
#   boot.raw                 the guest disk (raw, sparse copy of Tart's disk.img)
#   auxiliary.bin            Tart's nvram.bin (VZMacAuxiliaryStorage)
#   hardware-model.bin       VZMacHardwareModel.dataRepresentation (from config.json)
#   machine-identifier.bin   VZMacMachineIdentifier.dataRepresentation (from config.json)
#   manifest.json            sizes + sha256 of every file
# Per-attempt copies are APFS clones of these (same volume), made by the owner
# staging step. The master is root-owned and read-only; never boot it directly.
# Refuses to overwrite an existing image. Deletes nothing.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
VM=${1:?tart vm name}; NAME=${2:?image name}
[[ $NAME =~ ^[a-z0-9][a-z0-9._-]{2,63}$ ]] || { echo "bad image name" >&2; exit 1; }
SRC=/Volumes/FoundryBuild/images/tart/vms/$VM
DST=/Library/Foundry/VM/images/$NAME
[[ -f $SRC/disk.img && -f $SRC/nvram.bin && -f $SRC/config.json ]] || { echo "not a tart VM: $SRC" >&2; exit 1; }
mount | grep -q " on /Library/Foundry/VM " || { echo "/Library/Foundry/VM is not mounted" >&2; exit 1; }
pgrep -f "tart run $VM" >/dev/null && { echo "$VM is running; stop it first" >&2; exit 1; }
[[ -e $DST ]] && { echo "$DST exists; refusing to overwrite" >&2; exit 1; }

install -d -o root -g wheel -m 0755 "$DST"
echo "copying disk (sparse)..."
/bin/dd if="$SRC/disk.img" of="$DST/boot.raw" bs=8m conv=sparse status=none
cp "$SRC/nvram.bin" "$DST/auxiliary.bin"
/usr/bin/python3 - "$SRC/config.json" "$DST" <<'PY'
import base64, json, sys
cfg = json.load(open(sys.argv[1]))
assert cfg.get("diskFormat") == "raw" and cfg.get("os") == "darwin" and cfg.get("arch") == "arm64", cfg
open(sys.argv[2] + "/hardware-model.bin", "wb").write(base64.b64decode(cfg["hardwareModel"]))
open(sys.argv[2] + "/machine-identifier.bin", "wb").write(base64.b64decode(cfg["ecid"]))
PY
chown root:wheel "$DST"/*; chmod 0444 "$DST"/*
echo "hashing..."
/usr/bin/python3 - "$DST" "$VM" "$NAME" <<'PY'
import hashlib, json, os, sys, datetime
d, vm, name = sys.argv[1:4]
files = {}
for f in ("boot.raw", "auxiliary.bin", "hardware-model.bin", "machine-identifier.bin"):
    h = hashlib.sha256()
    with open(os.path.join(d, f), "rb") as fh:
        for chunk in iter(lambda: fh.read(8 << 20), b""):
            h.update(chunk)
    st = os.stat(os.path.join(d, f))
    files[f] = {"bytes": st.st_size, "allocated_bytes": st.st_blocks * 512, "sha256": h.hexdigest()}
m = {"schema": "foundry.mac-guest-image.v1", "name": name, "source_tart_vm": vm,
     "exported_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"), "files": files}
with open(os.path.join(d, "manifest.json"), "w") as fh:
    json.dump(m, fh, indent=2)
os.chmod(os.path.join(d, "manifest.json"), 0o444)
print(json.dumps(m, indent=2))
PY
ls -la "$DST"; df -h /Library/Foundry/VM | tail -1
