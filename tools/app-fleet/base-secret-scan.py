#!/usr/bin/env python3
"""Scan every Foundry base's current main for files the seeder's secret filter would withhold.

Seeds made before the filter (onboard.py secret_rule) copied every text file from GitHub,
including committed .env files and keys. This fetches each registry base into a temporary
repo and applies the same rules to every blob on main. Output is path + rule only: matched
text is never printed or written.

  base-secret-scan.py [--ids a,b] [--out receipts/app-fleet/secret-scan.<ts>.json]
"""
import argparse, importlib.util, json, pathlib, subprocess, sys, tempfile, time
from concurrent.futures import ThreadPoolExecutor

LOCKFIX = pathlib.Path(__file__).resolve().parents[2]
FETCH = pathlib.Path.home() / ".config/foundry/bin/foundry-fetch"
spec = importlib.util.spec_from_file_location("onboard", LOCKFIX / "tools/app-fleet/onboard.py")
onboard = importlib.util.module_from_spec(spec); spec.loader.exec_module(onboard)


def scan(base, work):
    d = work / base
    subprocess.run(["git", "init", "-q", str(d)], check=True)  # foundry-fetch needs a work tree root
    for attempt in range(3):
        r = subprocess.run([str(FETCH), base, "+main:refs/remotes/foundry/main"], cwd=d, capture_output=True, text=True)
        if r.returncode == 0:
            break
        time.sleep(5)
    else:
        return {"base": base, "error": "fetch failed: " + r.stderr.strip()[-160:]}
    rows = subprocess.run(["git", "-C", str(d), "ls-tree", "-r", "-z", "foundry/main"], capture_output=True, text=True, check=True).stdout
    hits = []
    for row in filter(None, rows.split("\0")):
        meta, path = row.split("\t", 1)
        mode, typ, oid = meta.split()
        if typ != "blob" or mode == "120000":
            continue
        data = subprocess.run(["git", "-C", str(d), "cat-file", "blob", oid], capture_output=True, check=True).stdout
        rule = onboard.secret_rule(path, data)
        if rule:
            hits.append({"path": path, "rule": rule})
    return {"base": base, "hits": hits}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids")
    ap.add_argument("--out")
    a = ap.parse_args()
    reg = json.load(open(LOCKFIX / "docs/app-fleet/apps.v1.json"))["records"]
    ids = set(a.ids.split(",")) if a.ids else None
    bases = sorted({r["foundry_base"] for r in reg if r.get("foundry_base") and (ids is None or r["id"] in ids)})
    with tempfile.TemporaryDirectory(prefix="base-secret-scan-") as w, ThreadPoolExecutor(6) as ex:
        res = list(ex.map(lambda b: scan(b, pathlib.Path(w)), bases))
    for r in res:
        if r.get("error") or r["hits"]:
            print(json.dumps(r))
    print(f"{len(bases)} bases scanned; {sum(1 for r in res if r.get('hits'))} with hits; "
          f"{sum(len(r.get('hits', [])) for r in res)} files; {sum(1 for r in res if r.get('error'))} fetch errors")
    out = pathlib.Path(a.out) if a.out else LOCKFIX / f"receipts/app-fleet/secret-scan.{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.json"
    out.write_text(json.dumps(res, indent=1))


if __name__ == "__main__":
    sys.exit(main())
