#!/bin/bash
# Root, one-time per image: write a FULLY ALLOCATED copy of a master boot.raw.
# mac-vm-host refuses sparse boot disks (lseek SEEK_HOLE must equal size and
# st_blocks must cover size), and Tart/VZ images are sparse. An APFS clone of a
# dense file is dense, so per-attempt boot disks stay instant clones of this one.
# Template: @IMAGE@ = image directory name under /Library/Foundry/VM/images,
# @BOOT_SHA@ = its boot.raw sha256 (verified while copying, every byte written).
set -euo pipefail
IMAGE='@IMAGE@'
BOOT_SHA='@BOOT_SHA@'
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
