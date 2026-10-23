# Compose request 14 once image r3's manifest is known: capability v4 seal,
# three source seals, Mo en Movimiento + Air Deck builds. Every script it runs is
# a file under ~/.foundry-obs whose sha256 is pinned here and checked as root
# before execution.
import hashlib, json, subprocess, sys
D = "docs/cloud-workspaces/mac-worker-2026-10-21"
manifest, = sys.argv[1:2]
m = json.load(open(manifest))
boot = m["files"]["boot.raw"]["sha256"]
obs = f"{D}/capability-observation-runner-v3.json"
cap_rec = json.loads(subprocess.check_output(["node_modules/.bin/tsx", "tools/foundry-mac-host/capability-record.ts",
    obs, manifest,
    "10af1eb5d20b792eaa216c680e69e55814e876bbd885d849855fea7b1a0778a2",
    "703035a4fd974f1a3b9da67228ad8ef60d0a21847b679bda1d05f771e2a2b898"]))
cap = cap_rec["sha256"]
canon = json.dumps(cap_rec["capability"], sort_keys=True, separators=(',', ':'), ensure_ascii=False)
assert hashlib.sha256(canon.encode()).hexdigest() == cap
json.dump(cap_rec, open(f"{D}/capability-record-v5.json", "w"), indent=1)
tpl = open("tools/foundry-mac-host/seal-capability.sh").read().splitlines()
seal = "\n".join(("CAP_SHA='%s'" % cap) if l.startswith("CAP_SHA='@") else ("CAP_JSON='%s'" % canon) if l.startswith("CAP_JSON='@") else l for l in tpl) + "\n"
open(f"{D}/sources/seal-capability-v5.sh", "w").write(seal)
files = {"seal-capability-v5.sh": f"{D}/sources/seal-capability-v5.sh",
         "build-job.sh": "tools/foundry-mac-host/build-job.sh"}
import glob
for p in glob.glob(f"{D}/sources/seal-*-*.sh"):
    if "capability" not in p: files[p.split("/")[-1]] = p
for a in ("mo", "airdeck", "coltivare"): files[f"{a}.files"] = f"{D}/sources/{a}.files"
pins = {k: hashlib.sha256(open(v, "rb").read()).hexdigest() for k, v in files.items()}
srcs = {k: k for k in files if k.startswith("seal-") and "capability" not in k}
mo = [k for k in srcs if "mo-en-" in k][0][5:-3]; ad = [k for k in srcs if "airdeck" in k][0][5:-3]; co = [k for k in srcs if "coltivare" in k][0][5:-3]
common = f"IMAGE=macos-27.0.1-xcode-27.1-r4 BOOT_SHA={boot} CAP_SHA={cap} RUNNER_SHA=2182a9ac4523063aa3be1767fd31fdc447df469dde856157d3083a2eba7901b2"
def job(att, jid, src, proj, scheme, conf, app, extra=""):
    return f'{common} ATT={att} JOB_ID={jid} SRC_NAME={src} PROJECT={proj} SCHEME={scheme} CONFIGURATION={conf} OUTPUT_PATH=DerivedData/Build/Products/{conf}-iphoneos/{app}.app {extra} bash "$O/build-job.sh"'
lines = ["#!/bin/bash",
 "# Request 17 on Mac5: seal capability v5 (image r4 + guest runner v3 + helper 10af1eb5),",
 "# then build Mo en Movimiento and Air Deck from the already-sealed sources",
 "# (results delivered to /Volumes/FoundryBuild/staging/results).",
 "# Every script run here is pinned by sha256 below. Deletes nothing.",
 "LOG=/Library/Foundry/VM/proof-logs/request17.log; : > \"$LOG\"; chmod 0644 \"$LOG\"",
 "exec > >(tee -a \"$LOG\") 2>&1",
 "O=/Users/mohameddiomande/.foundry-obs",
 "pin() { [[ $(shasum -a 256 \"$O/$1\" | cut -c1-64) == \"$2\" ]] || { echo \"!! PIN MISMATCH $1\"; exit 1; }; }"]
for k, v in sorted(pins.items()): lines.append(f"pin {k} {v}")
lines += ['echo "== capability v4"; bash "$O/seal-capability-v5.sh" || { echo "!! capability seal FAILED"; exit 1; }']
pass
lines += ['echo "== build Mo en Movimiento"', job("mo-581552c-b", "mo-en-movimiento-1", mo, "App/MoEnMovimiento.xcodeproj", "MoEnMovimiento", "Debug", "MoEnMovimiento", "TIMEOUT_S=2400 OUT_DISK_GIB=4"),
          'echo "== build Air Deck"', job("airdeck-b12322a-b", "airdeck-1", ad, "AirDeck.xcodeproj", "AirDeck", "Debug", "AirDeck", "TIMEOUT_S=1800 OUT_DISK_GIB=2"),
          'echo "== request 17 done"']
open(f"{D}/request17-cap-v5-build-mo-airdeck-mac5.sh", "w").write("\n".join(lines) + "\n")
r15 = lines[:9] + [f"pin build-job.sh {pins['build-job.sh']}", 'echo "== build Coltivare"',
       job("coltivare-f3855fb-b", "coltivare-1", co, "Coltivare.xcodeproj", "Coltivare", "Release", "Coltivare", "TIMEOUT_S=3300 CPU=4 MEM_GIB=6 OUT_DISK_GIB=2"), 'echo "== request 18 done"']
r15[0:6] = ["#!/bin/bash", "# Request 18 on Mac5: build Coltivare (Release, prefetched packages) on image r4. Pinned build-job.sh. Deletes nothing.",
            "LOG=/Library/Foundry/VM/proof-logs/request18.log; : > \"$LOG\"; chmod 0644 \"$LOG\""]
open(f"{D}/request18-coltivare-build-mac5.sh", "w").write("\n".join(r15) + "\n")
print("cap v4", cap, "boot", boot); print("upload:", " ".join(files.values()))
