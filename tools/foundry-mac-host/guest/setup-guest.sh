#!/bin/bash
# Runs INSIDE the Foundry build VM as admin (passwordless sudo). Idempotent.
# Copy packages/build-runtime/native/mac-vm-guest.py to /tmp in the guest first.
# Prepares everything except the boot runner LaunchDaemon (installed last).
set -euo pipefail

if ! id foundry-build >/dev/null 2>&1; then
  sudo -n sysadminctl -addUser foundry-build -fullName "Foundry build" \
    -password "$(openssl rand -base64 32)" -home /var/empty-foundry-build >/dev/null 2>&1
fi
sudo -n dscl . create /Users/foundry-build IsHidden 1
sudo -n dscl . create /Users/foundry-build UserShell /usr/bin/false
echo "user: $(id foundry-build)"

sudo -n install -d -o root -g wheel -m 0755 /Library/Foundry /Library/Foundry/guest
sudo -n install -o root -g wheel -m 0644 /tmp/mac-vm-guest.py /Library/Foundry/guest/mac-vm-guest.py
# The runner creates /private/var/foundry/work itself but not its parent.
sudo -n install -d -o root -g wheel -m 0755 /private/var/foundry
echo "runner: $(shasum -a 256 /Library/Foundry/guest/mac-vm-guest.py)"

sudo -n pmset -a sleep 0 displaysleep 0 disksleep 0 >/dev/null
sudo -n defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticDownload -bool false
sudo -n defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false
sudo -n mdutil -a -i off >/dev/null 2>&1 || true
echo "housekeeping: sleep off, auto-updates off, Spotlight off"

echo "python: $(/usr/bin/python3 --version 2>&1)"
echo "CAPABILITY:"
/usr/bin/python3 /Library/Foundry/guest/mac-vm-guest.py --describe-capability /Applications/Xcode.app/Contents/Developer
