#!/usr/bin/env python3
"""Build the app-fleet registry (fleet/apps.v1.json) from the four evidence sources.

Sources (all read-only, no secrets):
  1. GitHub repo list for the account      (gh repo list ... --json, cached as a file)
  2. ios-apps.md memory table              (bundle ids, waves, TestFlight state)
  3. Foundry library catalog r3            (~/Developer/Foundry-Library/catalogs/r3/catalog.json)
  4. Fleet backup manifest                 (~/.fleet-backup/manifest.tsv, status ok rows)

One record per origin (GitHub repo). Library-only and archive-only entries that match no
repo are emitted as records with origin=null so nothing is lost. Tier defaults come from
--hot-days (push recency) and the keepers list; everything else is cold. The output is the
authority once it is landed in the foundry base through the gate; until then it is a draft.
"""
import argparse, csv, json, re, subprocess, sys, datetime, pathlib, collections

HOME = pathlib.Path.home()
KEEPERS_HOT = {  # from portfolio-final-keepers-2026-05-17 + lanes active in Oct 2026
    "motionmix", "motionmixapp", "motionmix-ableton", "airdeck", "fabric", "bwb-site",
    "coltivare", "nko-speech", "sharedservices", "foundry", "comp-core", "lume-commerce",
    "meshcontrol", "homebase",
}
KEEPERS_WARM = {"mfp", "meaning-full-power", "spore", "aura", "creativedirector", "securiclaw",
                "securiclaw-claude", "securiclaw-codex", "speakflow", "nko", "nko-brain-scanner",
                "skateforge", "milkmendelivery", "milk-men-", "koji-crm", "bwb", "serenity-soother",
                "learnnko", "jeli-nko", "nko-keyboard-ai"}
WAVES = ["Flagship", "Trajectory Bloom", "Wave 3", "Fleet 3"]
EXCLUDED = {"homebase": "the home directory itself; never a Foundry base", ".github": "account profile repo"}


def norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def load_gh(path):
    if path and pathlib.Path(path).exists():
        return json.load(open(path))
    out = subprocess.run(["gh", "repo", "list", "Diomandeee", "--limit", "400", "--json",
                          "name,isPrivate,pushedAt,diskUsage,isArchived,url,description"],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def load_ios_apps(path):
    """Parse ios-apps.md: rows carrying Diomandeee/<repo>; wave from the nearest heading."""
    apps, wave = {}, None
    for line in open(path, encoding="utf-8"):
        h = re.match(r"#+\s*(.*)", line)
        if h:
            for w in WAVES:
                if w.lower() in h.group(1).lower():
                    wave = w
        m = re.search(r"Diomandeee/([A-Za-z0-9_.-]+)", line)
        if not m:
            continue
        repo = m.group(1)
        b = re.search(r"(com\.[a-z0-9.-]+)", line)
        tf = "testflight" in line.lower() or "tf" in line.lower()
        apps.setdefault(repo, {"bundle_id": b.group(1) if b else None, "wave": wave,
                               "testflight_mentioned": tf})
    return apps


def load_library(path):
    d = json.load(open(path))
    out = {}
    for p in d["projects"]:
        out.setdefault(norm(p.get("title")), []).append({
            "library_id": p.get("id"), "title": p.get("title"),
            "machines": p.get("machines"), "delivered": not str(p.get("defaultReason", "")).startswith("No delivered"),
            "needs_version_choice": "choose a preserved version" in str(p.get("defaultReason", "")),
        })
    return out, d.get("revision")


def load_manifest(path):
    out = {}
    with open(path) as f:
        rows = list(csv.reader(f, delimiter="\t"))
    for r in rows:
        if len(r) < 9 or r[8] != "ok":
            continue
        root, name, md5, nbytes = r[0], r[1], r[2], int(r[3])
        backend = r[10] if len(r) > 10 else "drive"
        out.setdefault(norm(name), []).append({
            "root": root, "name": name, "md5": md5, "bytes": nbytes, "backend": backend,
            "path": f"Fleet-Backup/mac1/2026-10-18/{root}/{name}.tar.zst",
        })
    return out


def tier_for(name, pushed, hot_days, now):
    n = name.lower()
    if n in EXCLUDED:
        return "excluded", EXCLUDED[n]
    if n in KEEPERS_HOT:
        return "hot", "keeper"
    if pushed:
        age = (now - datetime.datetime.fromisoformat(pushed.replace("Z", "+00:00"))).days
        if age <= hot_days:
            return "hot", f"pushed {age}d ago"
    if n in KEEPERS_WARM:
        return "warm", "keeper-warm"
    return "cold", "dormant"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gh-json", default=None, help="cached gh repo list json (else call gh)")
    ap.add_argument("--ios-apps", default=str(HOME / ".claude/projects/-Users-mohameddiomande/memory/ios-apps.md"))
    ap.add_argument("--catalog", default=str(HOME / "Developer/Foundry-Library/catalogs/r3/catalog.json"))
    ap.add_argument("--manifest", default=str(HOME / ".fleet-backup/manifest.tsv"))
    ap.add_argument("--hot-days", type=int, default=60)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    now = datetime.datetime.now(datetime.timezone.utc)
    gh = load_gh(a.gh_json)
    ios = load_ios_apps(a.ios_apps)
    lib, lib_rev = load_library(a.catalog)
    man = load_manifest(a.manifest)

    records, used_lib, used_man = [], set(), set()
    for r in sorted(gh, key=lambda x: x["name"].lower()):
        k = norm(r["name"])
        ios_meta = ios.get(r["name"]) or ios.get(next((n for n in ios if norm(n) == k), ""), None)
        lib_hits = lib.get(k, [])
        man_hits = man.get(k, [])
        used_lib.add(k) if lib_hits else None
        used_man.add(k) if man_hits else None
        tier, why = tier_for(r["name"], r.get("pushedAt"), a.hot_days, now)
        kind = "ios" if ios_meta else ("archived-repo" if r.get("isArchived") else "repo")
        records.append({
            "id": r["name"].lower(),
            "title": r["name"],
            "kind": kind,
            "origin": r.get("url") or f"https://github.com/Diomandeee/{r['name']}",
            "private": r.get("isPrivate"),
            "github_archived": r.get("isArchived"),
            "github_kb": r.get("diskUsage"),
            "last_push": (r.get("pushedAt") or "")[:10] or None,
            "bundle_id": (ios_meta or {}).get("bundle_id"),
            "wave": (ios_meta or {}).get("wave"),
            "library": lib_hits,
            "archive": man_hits,
            "tier": tier,
            "tier_reason": why,
            "owner_lane": None,
            "allowed_roots": None,
            "binary_policy": None,
            "foundry_base": None,
        })

    # library-only and archive-only entries (no GitHub origin)
    for k, hits in lib.items():
        if k in used_lib or not k:
            continue
        records.append({"id": "lib:" + k, "title": hits[0]["title"], "kind": "library-only", "origin": None,
                        "library": hits, "archive": man.get(k, []), "tier": "cold", "tier_reason": "no remote",
                        "owner_lane": None, "foundry_base": None})
        used_man.add(k)
    for k, hits in man.items():
        if k in used_man or k in used_lib:
            continue
        records.append({"id": "archive:" + k, "title": hits[0]["name"], "kind": "archive-only", "origin": None,
                        "library": [], "archive": hits, "tier": "cold", "tier_reason": "archive only, no remote",
                        "owner_lane": None, "foundry_base": None})

    summary = {
        "records": len(records),
        "by_kind": dict(collections.Counter(r["kind"] for r in records)),
        "by_tier": dict(collections.Counter(r["tier"] for r in records)),
        "ios_apps": sum(1 for r in records if r["kind"] == "ios"),
        "github_repos": len(gh),
        "library_entries": sum(len(v) for v in lib.values()),
        "archive_ok_rows": sum(len(v) for v in man.values()),
    }
    out = {"format": "foundry.app-fleet.v1", "built_at": now.isoformat(timespec="seconds"),
           "library_revision": lib_rev, "summary": summary, "records": records}
    pathlib.Path(a.out).write_text(json.dumps(out, indent=1))
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
