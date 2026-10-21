#!/bin/bash
# Runs INSIDE the Foundry build VM. Installs the boot hook LAST.
set -euo pipefail

sudo -n tee /Library/Foundry/guest/boot-runner.sh >/dev/null <<'EOF'
#!/bin/bash
# Foundry guest boot hook. A job boot has both volumes attached by the host
# (the read-only input share and the FoundryOutputs disk): hand over to the
# pinned runner, which always shuts the VM down. A boot without them is a
# maintenance boot: do nothing and leave the VM up.
IN="/Volumes/My Shared Files"; OUT=/Volumes/FoundryOutputs
for _ in $(seq 1 120); do
  if /sbin/mount | /usr/bin/grep -q " on $IN " && /sbin/mount | /usr/bin/grep -q " on $OUT "; then
    exec /usr/bin/python3 /Library/Foundry/guest/mac-vm-guest.py
  fi
  sleep 1
done
echo "no job volumes after 120 s: maintenance boot, runner not started" >&2
exit 0
EOF
sudo -n chown root:wheel /Library/Foundry/guest/boot-runner.sh
sudo -n chmod 0755 /Library/Foundry/guest/boot-runner.sh

sudo -n tee /Library/LaunchDaemons/com.foundry.guest-runner.plist >/dev/null <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.foundry.guest-runner</string>
  <key>ProgramArguments</key><array><string>/Library/Foundry/guest/boot-runner.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardErrorPath</key><string>/var/log/foundry-guest-runner.log</string>
</dict>
</plist>
EOF
sudo -n chown root:wheel /Library/LaunchDaemons/com.foundry.guest-runner.plist
sudo -n chmod 0644 /Library/LaunchDaemons/com.foundry.guest-runner.plist
/usr/bin/plutil -lint /Library/LaunchDaemons/com.foundry.guest-runner.plist
ls -la /Library/Foundry/guest/
shasum -a 256 /Library/Foundry/guest/*
echo "installed; shutting down"
sudo -n /sbin/shutdown -h +0 >/dev/null 2>&1 &
