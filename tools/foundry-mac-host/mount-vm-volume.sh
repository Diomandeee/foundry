#!/usr/bin/env bash
# Give the Mac VM runtime its fixed root on the external build drive.
#
#   sudo bash mount-vm-volume.sh
#
# packages/build-runtime hardcodes /Library/Foundry/VM/{attempts,sources,...}
# and the native helper opens every path component with O_NOFOLLOW, so the
# root cannot be a symlink to the external drive. Instead this adds an APFS
# volume "FoundryVM" to the FoundryBuild container and mounts it AT
# /Library/Foundry/VM, persistently (fstab by volume UUID). Attempts and the
# master guest image then share one volume, so each attempt's boot.raw is an
# instant APFS clone of the master, not a 100 GB copy.
#
# Idempotent. Changes: one APFS volume, /etc/fstab (one line, backed up), the
# mount point and root-owned directories under it. Deletes nothing.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }

BUILD=/Volumes/FoundryBuild
MP=/Library/Foundry/VM
NAME=FoundryVM

[[ -d $BUILD ]] || { echo "$BUILD is not mounted (plug in the T7)" >&2; exit 1; }
container=$(diskutil info "$BUILD" | awk -F': *' '/APFS Container/ {print $2}')
[[ $container == disk* ]] || { echo "cannot find the APFS container of $BUILD" >&2; exit 1; }

if ! diskutil apfs list "$container" | grep -q "Name: *$NAME "; then
  diskutil apfs addVolume "$container" APFS "$NAME" -nomount
fi
dev=$(diskutil apfs list "$container" | awk -v n="$NAME" '
  /APFS Volume Disk/ { for (i = 1; i <= NF; i++) if ($i ~ /^disk[0-9]+s[0-9]+$/) d = $i }
  $0 ~ "Name: *"n" " { print d; exit }')
uuid=$(diskutil info "$dev" | awk -F': *' '/Volume UUID/ {print $2}')
[[ -n $uuid ]] || { echo "no UUID for $NAME" >&2; exit 1; }

install -d -o root -g wheel -m 0755 /Library/Foundry "$MP"
if ! grep -q "$uuid" /etc/fstab 2>/dev/null; then
  [[ -f /etc/fstab ]] && cp -p /etc/fstab "/etc/fstab.pre-foundry-$(date +%Y%m%d%H%M%S)"
  echo "UUID=$uuid $MP apfs rw" >> /etc/fstab
fi
if ! mount | grep -q " on $MP "; then
  diskutil mount -mountPoint "$MP" "$dev"
fi
diskutil enableOwnership "$MP" >/dev/null
chown root:wheel "$MP"; chmod 0755 "$MP"
install -d -o root -g wheel -m 0755 "$MP/attempts" "$MP/sources" "$MP/capabilities" "$MP/images"
mdutil -i off "$MP" >/dev/null 2>&1 || true

echo "ready: $NAME ($dev, UUID $uuid) mounted at $MP"
df -h "$MP" | tail -1
ls -la "$MP"
