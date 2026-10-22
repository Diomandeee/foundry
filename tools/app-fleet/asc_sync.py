#!/usr/bin/env python3
"""Pull the live App Store Connect app list and join it onto the app-fleet registry.

Read-only against ASC (GET only). Writes docs/app-fleet/asc.v1.json and, with --merge,
rewrites the registry with asc_app_id / asc_name / asc_sku / asc_store_state / asc_latest_build
on every record whose bundle_id matches. Nothing is renamed or changed on ASC here.

Credentials: key id and issuer id from ~/.appstoreconnect/config, the .p8 from
~/.appstoreconnect/private_keys. The key material is only used to sign the JWT; it is never
printed or copied.
"""
import argparse, json, pathlib, re, sys, time, datetime, urllib.request, urllib.parse
import jwt

HOME = pathlib.Path.home()
LOCKFIX = pathlib.Path(__file__).resolve().parents[2]
API = "https://api.appstoreconnect.apple.com"
LIVE_STATES = {"READY_FOR_SALE", "READY_FOR_DISTRIBUTION", "PENDING_DEVELOPER_RELEASE", "PENDING_APPLE_RELEASE",
               "IN_REVIEW", "WAITING_FOR_REVIEW", "PROCESSING_FOR_DISTRIBUTION"}


def creds():
    cfg = (HOME / ".appstoreconnect/config").read_text()
    key_id = re.search(r"(?im)^\s*(?:ASC_)?KEY_ID\s*[=:]\s*([A-Z0-9]{10})", cfg)
    issuer = re.search(r"(?im)^\s*(?:ASC_)?ISSUER_ID\s*[=:]\s*([0-9a-f-]{36})", cfg)
    key_id = key_id.group(1) if key_id else None
    issuer = issuer.group(1) if issuer else (HOME / ".config/asc-issuer-id.txt").read_text().strip()
    if not key_id:
        p8s = sorted((HOME / ".appstoreconnect/private_keys").glob("AuthKey_*.p8"))
        key_id = p8s[0].stem.split("_", 1)[1]
    p8 = HOME / ".appstoreconnect/private_keys" / f"AuthKey_{key_id}.p8"
    return key_id, issuer, p8


def token(key_id, issuer, p8):
    now = int(time.time())
    return jwt.encode({"iss": issuer, "iat": now, "exp": now + 1100, "aud": "appstoreconnect-v1"},
                      p8.read_text(), algorithm="ES256", headers={"kid": key_id, "typ": "JWT"})


def get(tok, path, params=None):
    url = API + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def paged(tok, path, params):
    out, nxt = [], None
    while True:
        d = get(tok, path, params) if nxt is None else json.load(urllib.request.urlopen(
            urllib.request.Request(nxt, headers={"Authorization": f"Bearer {tok}"}), timeout=60))
        out += d.get("data", [])
        nxt = (d.get("links") or {}).get("next")
        if not nxt:
            return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(LOCKFIX / "docs/app-fleet/asc.v1.json"))
    ap.add_argument("--registry", default=str(LOCKFIX / "docs/app-fleet/apps.v1.json"))
    ap.add_argument("--merge", action="store_true", help="write ASC fields back into the registry")
    ap.add_argument("--versions", action="store_true", help="also fetch store versions + latest build per app (slow)")
    ap.add_argument("--from-file", action="store_true", help="do not pull; reuse the existing asc.v1.json (merge only)")
    a = ap.parse_args()

    if a.from_file:
        prev = json.load(open(a.out)); rows = prev["apps"]; key_id = prev.get("key_id"); apps = []
    else:
        key_id, issuer, p8 = creds()
        tok = token(key_id, issuer, p8)
        apps = paged(tok, "/v1/apps", {"limit": 200, "fields[apps]": "name,bundleId,sku,primaryLocale"})
        rows = []
    for app in apps:
        at = app["attributes"]
        row = {"asc_app_id": app["id"], "name": at.get("name"), "bundle_id": at.get("bundleId"),
               "sku": at.get("sku"), "locale": at.get("primaryLocale"),
               "store_versions": [], "latest_build": None, "live": None, "localizations": []}
        if a.versions:
            try:
                vs = get(tok, f"/v1/apps/{app['id']}/appStoreVersions",
                         {"limit": 50, "fields[appStoreVersions]": "versionString,appStoreState,platform,createdDate"})
                row["store_versions"] = [{"v": v["attributes"]["versionString"], "state": v["attributes"]["appStoreState"],
                                          "platform": v["attributes"]["platform"],
                                          "created": v["attributes"]["createdDate"][:10]} for v in vs.get("data", [])]
                row["live"] = any(v["state"] in LIVE_STATES for v in row["store_versions"])
                locs = []
                for info in get(tok, f"/v1/apps/{app['id']}/appInfos", {"limit": 2}).get("data", []):
                    l = get(tok, f"/v1/appInfos/{info['id']}/appInfoLocalizations", {"limit": 10})
                    locs += [{"appInfo": info["id"], "id": x["id"], "loc": x["attributes"].get("locale"),
                              "name": x["attributes"].get("name"), "subtitle": x["attributes"].get("subtitle")} for x in l.get("data", [])]
                row["localizations"] = locs
                b = get(tok, "/v1/builds", {"filter[app]": app["id"], "limit": 1, "sort": "-uploadedDate",
                                             "fields[builds]": "version,uploadedDate,processingState,expired"})
                if b.get("data"):
                    ba = b["data"][0]["attributes"]
                    row["latest_build"] = {"build": ba.get("version"), "uploaded": (ba.get("uploadedDate") or "")[:10],
                                           "state": ba.get("processingState"), "expired": ba.get("expired")}
            except Exception as e:  # keep going; record the failure
                row["error"] = str(e)[:120]
        rows.append(row)

    if not a.from_file:
        out = {"format": "foundry.asc-apps.v1", "pulled_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
               "key_id": key_id, "count": len(rows), "apps": rows}
        pathlib.Path(a.out).write_text(json.dumps(out, indent=1))

    openclaw = [r for r in rows if "openclaw" in (r["bundle_id"] or "").lower() or "openclaw" in (r["name"] or "").lower()
                or "claw" in (r["name"] or "").lower()]
    print(f"ASC apps: {len(rows)}; bundle/name carrying openclaw/claw: {len(openclaw)}")

    if a.merge:
        reg = json.load(open(a.registry))
        by_bundle = {r["bundle_id"].lower(): r for r in rows if r.get("bundle_id")}
        by_name = {(r["name"] or "").lower().replace(" ", ""): r for r in rows}
        # ASC bundle id -> registry id, for records whose bundle in ios-apps.md differs from ASC
        ALIAS = {"com.diomande.spore": "spore", "com.brewswithbeats.bwb-customer": "bwb", "com.bufbarista.lifeos": "lifeos",
                 "com.brewswithbeats.visionclaw": "visionclaw", "com.speakflow.mobile": "speakflow", "com.openclaw.aura": "aura",
                 "com.mohameddiomande.firstdate": "firstdate", "com.openclaw.nko-bridge": "nko", "com.openclaw.hub": "openclawhub",
                 "buf-barista.bodybeat": "bodybeat", "com.openclaw.beaconapp": "beacon", "com.openclaw.stack": "stack",
                 "com.openclaw.nkoscribe": "nko", "com.mohameddiomande.lineskipcity": None, "com.mohameddiomande.parksightcity": None,
                 "com.mohameddiomande.thefloorreport": None, "com.mohameddiomande.cinemawalk": "comp-core",
                 "com.openclaw.motionmixapp": "motionmixapp", "com.diomande.meshcontrol": "meshcontrol",
                 "com.diomande.coltivare": "coltivare", "com.diomande.creatorshield": "creator-shield",
                 "com.mohameddiomande.meaningfullpower": "meaning-full-power", "buf-barista-milk-men": "milk-men-",
                 "buf-barista.serenitysoother": "serenity-soother", "com.bufbarista.eternal-serenity": "eternal_serenity",
                 "com.calilights.calilights": "calilightsios", "com.brewswithbeats.agentcommandcenter": "agentcommandcenter",
                 "com.mohameddiomande.creativedirector": "creativedirector", "com.openclaw.paneview": None}
        by_id = {rec["id"]: rec for rec in reg["records"]}
        for rec in reg["records"]:
            for k in [k for k in rec if k.startswith("asc_")]:
                del rec[k]
        for r in rows:
            tgt = ALIAS.get((r["bundle_id"] or "").lower())
            if tgt and tgt in by_id:
                by_name[tgt] = r
        hit, miss_reg = 0, []
        matched_ids = set()
        for rec in reg["records"]:
            m = None
            if rec.get("bundle_id"):
                m = by_bundle.get(rec["bundle_id"].lower())
            if not m:
                m = by_name.get(rec["id"]) or by_name.get((rec.get("title") or "").lower().replace("-", "").replace("_", "").replace(" ", ""))
            if m:
                hit += 1; matched_ids.add(m["asc_app_id"])
                rec.update({"asc_app_id": m["asc_app_id"], "asc_name": m["name"], "asc_bundle_id": m["bundle_id"],
                            "asc_sku": m["sku"], "asc_store_versions": m["store_versions"], "asc_latest_build": m["latest_build"]})
        for r in rows:
            if r["asc_app_id"] not in matched_ids:
                miss_reg.append(r)
        reg["summary"]["asc_matched"] = hit
        reg["summary"]["asc_unmatched"] = len(miss_reg)
        pathlib.Path(a.registry).write_text(json.dumps(reg, indent=1))
        print(f"registry records matched to ASC: {hit}; ASC apps with no registry record: {len(miss_reg)}")
        for r in miss_reg:
            print(f"  unmatched ASC app: {r['name']}  {r['bundle_id']}")


if __name__ == "__main__":
    main()
