#!/bin/bash
# TEMPORARY (2026-10-22): keeps the App Store Tailscale connected on Mac5.
# Why: the App Store variant runs inside Mohamed's login session and has been found "stopped" when the
# console switches to the foundrybuild account, which breaks the phone approval shortcuts (they SSH over
# Tailscale). Real fix: Tailscale's headless tailscaled as a root LaunchDaemon (no login session needed),
# then retire this agent. Remove: launchctl bootout gui/$(id -u)/com.fleet.tailscale-watchdog
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
LOG=$HOME/.fleet/tailscale-watchdog/events.log
st=$($TS status 2>&1 | head -1)
case "$st" in
  *"Tailscale is stopped"*|*"NeedsLogin"*|*"not running"*)
    out=$(/usr/bin/timeout 30 $TS up 2>&1 | tail -1)
    sleep 3; after=$($TS status 2>&1 | head -1)
    echo "$(date -u +%FT%TZ) was: ${st:0:60} | up: ${out:0:80} | now: ${after:0:60}" >> "$LOG" ;;
esac
