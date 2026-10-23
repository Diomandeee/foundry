#!/bin/bash
# Deliver the verified Mo en Movimiento build (attempt mo-581552c-e) from its intake tree. Attached files only.
LOG=/Library/Foundry/VM/proof-logs/deliver-mo.log; : > "$LOG"; chmod 0644 "$LOG"
exec > >(/usr/bin/tee -a "$LOG") 2>&1
/bin/bash "$FLEET_FILES/deliver-intake.sh" mo-581552c-e
