#!/usr/bin/env bash
# Install fleet-authority on this Mac (docs/DELEGATED-AUTHORITY.md §6 step 1).
#
#   sudo bash install-fleet-authority.sh <built fleet-authority binary> <host-name>
#
# Creates: /Library/FleetAuthority (root-only tree), the approver account
# `fleetapprover` (no password, no login; reachable only through sshd's forced
# command with keys in root-owned /etc/ssh/fleet_authorized_keys), the launchd
# daemon, and the initial policy (everything Tier 3, no automation). Idempotent.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
BIN=${1:?built binary}; HOST=${2:?host name, e.g. mac5}
R=/Library/FleetAuthority
APPROVER=fleetapprover

step() { echo "== $*"; }

step "tree"
install -d -o root -g wheel -m 0755 "$R" "$R/bin" "$R/templates"
install -d -o root -g wheel -m 0700 "$R/pending" "$R/log"
install -o root -g wheel -m 0555 "$BIN" "$R/bin/fleet-authority"
sha=$(shasum -a 256 "$R/bin/fleet-authority" | cut -c1-64)
printf '{"binary_sha256":"%s","installed_at":"%s","version":"fleet-authority/1.0"}\n' "$sha" "$(date -u +%FT%TZ)" > "$R/install-receipt.json"
chmod 0644 "$R/install-receipt.json"
ln -sf "$R/bin/fleet-authority" /usr/local/bin/fleet 2>/dev/null || true

step "approver account (no password, no shell login)"
if ! dscl . -read /Users/$APPROVER >/dev/null 2>&1; then
  uid=450
  while dscl . -search /Users UniqueID $uid | grep -q UniqueID; do uid=$((uid+1)); done
  dscl . -create /Users/$APPROVER
  dscl . -create /Users/$APPROVER UniqueID $uid
  dscl . -create /Users/$APPROVER PrimaryGroupID 20
  dscl . -create /Users/$APPROVER UserShell /bin/sh
  dscl . -create /Users/$APPROVER RealName "Fleet approver"
  dscl . -create /Users/$APPROVER NFSHomeDirectory /var/empty
  dscl . -create /Users/$APPROVER IsHidden 1
  dscl . -create /Users/$APPROVER Password '*'
fi
uid=$(dscl . -read /Users/$APPROVER UniqueID | awk '{print $2}')
echo "approver uid $uid"
# macOS Remote Login only admits members of com.apple.access_ssh.
dseditgroup -o checkmember -m $APPROVER com.apple.access_ssh >/dev/null 2>&1 \
  || dseditgroup -o edit -a $APPROVER -t user com.apple.access_ssh
touch /etc/ssh/fleet_authorized_keys; chown root:wheel /etc/ssh/fleet_authorized_keys; chmod 0644 /etc/ssh/fleet_authorized_keys

step "sshd: forced command for the approver"
install -d -m 0755 /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/010-fleet-approver.conf <<EOF
Match User $APPROVER
    AuthorizedKeysFile /etc/ssh/fleet_authorized_keys
    ForceCommand $R/bin/fleet-authority approver-shell
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PermitTTY no
    AllowAgentForwarding no
    AllowTcpForwarding no
    X11Forwarding no
    PermitTunnel no
    PermitUserRC no
EOF
grep -q "^Include /etc/ssh/sshd_config.d/\*" /etc/ssh/sshd_config || { echo "sshd_config lacks the Include line" >&2; exit 1; }
sshd -t && echo "sshd config valid"
# DenyUsers would also block the approver from the Remote Login allow-list on macOS;
# the account only reaches the forced command, nothing else.

step "policy (initial: everything Tier 3, no automation, no enrolled keys)"
if [[ ! -f $R/policy.json ]]; then
  cat > "$R/policy.json" <<EOF
{
  "v": 1,
  "host": "$HOST",
  "default_tier": 3,
  "expiry_s": 600,
  "approver_uids": [$uid],
  "enrolled_keys": [],
  "tier0_templates": {},
  "protected_path_patterns": ["/Library/FleetAuthority", "/etc/sudoers", "/Library/LaunchDaemons", "/etc/ssh"],
  "kill_switch": {"paused": false}
}
EOF
fi
chown root:wheel "$R/policy.json"; chmod 0600 "$R/policy.json"

step "launchd"
cat > /Library/LaunchDaemons/com.fleet.authority.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.fleet.authority</string>
  <key>ProgramArguments</key><array><string>$R/bin/fleet-authority</string><string>daemon</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardErrorPath</key><string>$R/log/daemon.err</string>
</dict>
</plist>
EOF
chown root:wheel /Library/LaunchDaemons/com.fleet.authority.plist; chmod 0644 /Library/LaunchDaemons/com.fleet.authority.plist
launchctl bootout system/com.fleet.authority 2>/dev/null || true
launchctl bootstrap system /Library/LaunchDaemons/com.fleet.authority.plist
sleep 1
"$R/bin/fleet-authority" status
echo "installed: binary sha $sha"
