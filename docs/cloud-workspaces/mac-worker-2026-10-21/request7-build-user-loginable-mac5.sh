#!/bin/bash
URL=http://100.84.118.106:9876
( bash -s ) <<'REQ' 2>&1 | tee /Library/Foundry/VM/proof-logs/request7.log | curl -s -m 600 -X POST --data-binary @- "$URL/request7" >/dev/null 2>&1
# Root: turn the Mac build worker account into a real, standard (non-admin) login
# user. Virtualization.framework only starts macOS guests for a user with a GUI
# login session (unlocked keychain + Secure Enclave key; a sessionless account
# gets VZErrorDomain -9), so the build account must be logged in, as a
# background Fast User Switching session, whenever builds run.
#
# Keeps uid/gid 520 (the build roots, journal and helper config are bound to it).
# Renames the record _foundrybuild -> foundrybuild (underscore names never show
# in the login UI), shell /bin/zsh, home /Users/foundrybuild, visible.
# Sets NO password: the owner sets it himself in System Settings > Users & Groups
# (Reset Password) so no agent ever knows it. Not admin, not in the SSH access
# group, not auto-login. Idempotent. Deletes nothing.
set -euo pipefail
OLD=_foundrybuild; NEW=foundrybuild; ID=520; HOME_DIR=/Users/foundrybuild
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
echo "== $(date -u +%H:%M:%SZ) build user -> loginable"
if dscl . -read "/Users/$OLD" RecordName >/dev/null 2>&1; then
  [[ $(dscl . -read "/Users/$OLD" UniqueID | awk '{print $2}') == "$ID" ]] || { echo "$OLD uid is not $ID" >&2; exit 1; }
  dscl . -change "/Users/$OLD" RecordName "$OLD" "$NEW"
fi
if dscl . -read "/Groups/$OLD" RecordName >/dev/null 2>&1; then
  dscl . -change "/Groups/$OLD" RecordName "$OLD" "$NEW"
fi
dscacheutil -flushcache
[[ $(id -u "$NEW") == "$ID" && $(id -g "$NEW") == "$ID" ]] || { echo "rename check failed" >&2; exit 1; }
dscl . -create "/Users/$NEW" RealName "Foundry Build"
dscl . -create "/Users/$NEW" UserShell /bin/zsh
dscl . -create "/Users/$NEW" NFSHomeDirectory "$HOME_DIR"
dscl . -create "/Users/$NEW" IsHidden 0
dscl . -create "/Groups/$NEW" RealName "Foundry Build"
if [[ ! -d $HOME_DIR ]]; then createhomedir -c -u "$NEW" >/dev/null; fi
chown -R "$ID:$ID" "$HOME_DIR"; chmod 0700 "$HOME_DIR"
dseditgroup -o checkmember -m "$NEW" admin >/dev/null 2>&1 && { echo "$NEW is admin; refusing" >&2; exit 1; }
dseditgroup -o checkmember -m "$NEW" com.apple.access_ssh >/dev/null 2>&1 && echo "note: $NEW is in the SSH access group" || true
# Old sessionless home from request 6 is left in place (empty, unused).
id "$NEW"
dscl . -read "/Users/$NEW" RecordName UniqueID PrimaryGroupID NFSHomeDirectory UserShell IsHidden RealName
ls -ld "$HOME_DIR" /Library/Foundry/VM/{input,work,journal,cache}
echo "fdesetup: $(fdesetup status)"; echo "autoLoginUser: $(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null)"
echo "== done: set the password in System Settings > Users & Groups > Foundry Build > Reset Password, then log in once"
REQ
chmod 0644 /Library/Foundry/VM/proof-logs/request7.log
