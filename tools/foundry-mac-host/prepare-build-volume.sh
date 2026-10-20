#!/usr/bin/env bash
# Prepare the external SSD that holds a Mac build worker's VM image and cache.
#
#   bash prepare-build-volume.sh <disk identifier>      e.g. disk6  (from `diskutil list external`)
#
# It ERASES that whole disk as APFS "FoundryBuild" (one confirmation prompt that
# shows the disk's name and size first), then lays out the directories the
# build runtime checks (owner-only, no ACLs) and prints the headroom the
# mac-vm image volume check will see (needs >= 50 GiB free after the image).
#
# Run it on the machine the drive stays on (Mac5). Never run it on HD2/HD5.
set -euo pipefail

DISK=${1:?usage: prepare-build-volume.sh <disk identifier, e.g. disk6>}
NAME=FoundryBuild

diskutil info "$DISK" >/dev/null 2>&1 || { echo "no such disk: $DISK" >&2; exit 1; }
[[ $(diskutil info "$DISK" | awk -F': *' '/Device Location|Internal/ {print $2}' | tr '\n' ' ') != *"Internal"* ]] \
  || { echo "$DISK is internal; refusing" >&2; exit 1; }
diskutil info "$DISK" | grep -q "Removable Media:.*Removable\|Device Location:.*External" \
  || { echo "$DISK does not look external; refusing" >&2; exit 1; }
size=$(diskutil info "$DISK" | awk -F': *' '/Disk Size/ {print $2}' | cut -d'(' -f1)
media=$(diskutil info "$DISK" | awk -F': *' '/Device \/ Media Name/ {print $2}')
for mp in $(diskutil info "$DISK" | awk -F': *' '/Mount Point/ {print $2}'); do
  [[ $mp == /Volumes/HD2 || $mp == /Volumes/HD5 ]] && { echo "that is $mp; refusing" >&2; exit 1; }
done

echo "About to ERASE $DISK: $media, $size, as APFS volume \"$NAME\"."
read -r -p "Type the disk identifier again to confirm: " confirm
[[ $confirm == "$DISK" ]] || { echo "aborted"; exit 1; }

diskutil eraseDisk APFS "$NAME" GPT "$DISK"
VOL=/Volumes/$NAME
# APFS volumes default to ignoring ownership on external disks; the build
# runtime requires owner-only directories, so ownership must be honoured.
sudo diskutil enableOwnership "$VOL"
sudo chown "$(id -u):$(id -g)" "$VOL"
chmod 0700 "$VOL"
for d in images cache workspaces staging; do
  install -d -m 0700 "$VOL/$d"
done
# Keep Spotlight and Time Machine off the build volume.
sudo mdutil -i off "$VOL" >/dev/null
sudo tmutil addexclusion -p "$VOL" 2>/dev/null || true

free_gib=$(df -g "$VOL" | awk 'NR==2 {print $4}')
echo "ready: $VOL ($free_gib GiB free; images/ cache/ workspaces/ staging/, mode 0700, ownership on)"
echo "next: build the macOS guest image into $VOL/images (needs Xcode 27.1 + the current macOS IPSW), then point MacVmWorkerConfig.bootDisk at it"
