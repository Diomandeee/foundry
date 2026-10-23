#!/bin/bash
# Request 13 on Mac5: export the stopped base VM (guest runner v2 ecd420d1:
# prefetched Swift packages, macro/plugin trust flags, 4 GiB results) as master
# image macos-27.0.1-xcode-27.1-r3, then write its fully allocated boot disk
# (hash-verified against the export manifest while copying). Deletes nothing.
LOG=/Library/Foundry/VM/proof-logs/request13.log; : > "$LOG"; chmod 0644 "$LOG"
exec > >(tee -a "$LOG") 2>&1
set -euo pipefail
NAME=macos-27.0.1-xcode-27.1-r3
echo "== $(date -u +%H:%M:%SZ) export"
bash -s foundry-macos27-base "$NAME" <<'EXPORT'
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
EXPORT
BOOT_SHA=$(/usr/bin/python3 -I -c "import json;print(json.load(open('/Library/Foundry/VM/images/$NAME/manifest.json'))['files']['boot.raw']['sha256'])")
echo "== $(date -u +%H:%M:%SZ) dense master, boot sha $BOOT_SHA"
IMAGE=$NAME
# Root, one-time per image: write a FULLY ALLOCATED copy of a master boot.raw.
# mac-vm-host refuses sparse boot disks (lseek SEEK_HOLE must equal size and
# st_blocks must cover size), and Tart/VZ images are sparse. An APFS clone of a
# dense file is dense, so per-attempt boot disks stay instant clones of this one.
# Template: @IMAGE@ = image directory name under /Library/Foundry/VM/images,
# @BOOT_SHA@ = its boot.raw sha256 (verified while copying, every byte written).
set -euo pipefail
IMAGE=${IMAGE}
BOOT_SHA=${BOOT_SHA}
SRC=/Library/Foundry/VM/images/$IMAGE/boot.raw
DIR=/Library/Foundry/VM/images/$IMAGE-dense
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
echo "== $(date -u +%H:%M:%SZ) dense master for $IMAGE"
if [[ -f $DIR/boot.raw ]]; then echo "$DIR/boot.raw already present"; else
  install -d -o root -g wheel -m 0755 "$DIR"
  /usr/bin/python3 -I - "$SRC" "$DIR/boot.raw.partial" "$BOOT_SHA" <<'PY'
import hashlib, os, sys
src, dst, want = sys.argv[1:4]
CH = 8 * 1024 * 1024
i = os.open(src, os.O_RDONLY | os.O_NOFOLLOW)
o = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
h = hashlib.sha256(); n = 0
size = os.fstat(i).st_size
while True:
    b = os.read(i, CH)
    if not b: break
    h.update(b)
    mv = memoryview(b)
    while mv:
        w = os.write(o, mv); mv = mv[w:]
    n += len(b)
    if n % (10 * 1024**3) < CH: print(f"  {n // 1024**3} GiB", flush=True)
os.fsync(o); os.close(o); os.close(i)
assert n == size, "short copy"
assert h.hexdigest() == want, f"hash {h.hexdigest()} != {want}"
print("copied", n, "bytes, sha256", h.hexdigest(), flush=True)
PY
  chown root:wheel "$DIR/boot.raw.partial"; chmod 0444 "$DIR/boot.raw.partial"
  mv "$DIR/boot.raw.partial" "$DIR/boot.raw"
fi
/usr/bin/python3 -I -c "
import os,sys
fd=os.open('$DIR/boot.raw',os.O_RDONLY);s=os.fstat(fd)
hole=os.lseek(fd,0,os.SEEK_HOLE)
print('size',s.st_size,'blocks',s.st_blocks,'hole_at',hole)
assert hole==s.st_size and s.st_blocks*512>=s.st_size, 'still sparse'
print('dense ok')"
ls -la "$DIR"
echo "== $(date -u +%H:%M:%SZ) request 13 done"
