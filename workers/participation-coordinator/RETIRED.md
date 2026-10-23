# Retired copy: do not deploy from here

The participation coordinator moved to its own repo and Foundry base on 2026-10-22:
`Diomandeee/participation-coordinator` (`~/Developer/participation-coordinator`, base `participation-coordinator`).
Production runs protocol v2 from that repo (`/health` version 57df85a at the time of writing), where the C1 kill switch was
replaced by operator-issued recovery grants.

This directory still holds the older v1 code (with the C1 kill switch). `wrangler deploy` from here would roll production
back, so `wrangler.toml` is renamed to `wrangler.toml.retired`. Delete this directory once the monorepo subtree is
retired through the gate.
