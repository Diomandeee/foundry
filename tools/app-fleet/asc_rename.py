#!/usr/bin/env python3
"""Plan (and, with Mohamed's words, apply) App Store Connect display-name changes that drop the
OpenClaw brand.

What can and cannot change on an existing ASC app record:
  - display name and subtitle: PATCH /v1/appInfoLocalizations/{id}   (changeable; this tool)
  - bundle id, SKU: immutable once a build was uploaded (every record here has builds). A new
    bundle id means a new app record, which this API key cannot create (web UI only).
  - App Store names must be unique across the store; bare words like "Anvil" or "Prism" are
    taken, which is why "— OpenClaw" was appended. --suffix supplies the replacement brand.

Dry run prints the proposals and writes receipts/app-fleet/asc-rename.dry-run.json.
--apply needs --approved-by "<Mohamed's words>" and performs one PATCH per localization,
recording each result (409 = name taken) in receipts/app-fleet/asc-rename.<ts>.json.
"""
import argparse, json, pathlib, re, sys, datetime, urllib.request, urllib.error
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import asc_sync as A

LOCKFIX = pathlib.Path(__file__).resolve().parents[2]
BRAND_RE = re.compile(r"\s*[—–-]\s*OpenClaw\s*$|\s*OpenClaw\s*[—–-]\s*", re.I)


def propose(name, suffix):
    base = BRAND_RE.sub("", name or "").strip()
    if base == (name or "").strip():
        return None  # nothing to strip
    return f"{base} {suffix}".strip() if suffix else base


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--asc", default=str(LOCKFIX / "docs/app-fleet/asc.v1.json"))
    ap.add_argument("--suffix", default="", help='replacement brand appended after the bare name, e.g. "by Diomande"')
    ap.add_argument("--also", default="", help="comma list of asc_app_id:New Name for apps the regex does not cover (VisionClaw AI)")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--approved-by", default=None)
    a = ap.parse_args()

    d = json.load(open(a.asc))
    extra = dict(x.split(":", 1) for x in a.also.split(",") if ":" in x)
    plan = []
    for app in d["apps"]:
        for loc in app.get("localizations", []):
            new = extra.get(app["asc_app_id"]) or propose(loc.get("name"), a.suffix)
            if new and new != loc.get("name"):
                plan.append({"asc_app_id": app["asc_app_id"], "bundle_id": app["bundle_id"], "localization_id": loc["id"],
                             "locale": loc["loc"], "old": loc.get("name"), "new": new, "subtitle": loc.get("subtitle"),
                             "chars": len(new)})
    for p in plan:
        flag = "  >30 chars" if p["chars"] > 30 else ""
        print(f"{p['bundle_id']:<40} {p['locale']:<6} {p['old']!r:<30} -> {p['new']!r}{flag}")
    print(f"\n{len(plan)} localizations to rename; {sum(1 for p in plan if p['chars'] > 30)} exceed the 30-char App Store name limit")
    rec_dir = LOCKFIX / "receipts/app-fleet"; rec_dir.mkdir(parents=True, exist_ok=True)
    (rec_dir / "asc-rename.dry-run.json").write_text(json.dumps({"suffix": a.suffix, "plan": plan}, indent=1))

    if not a.apply:
        return
    if not a.approved_by:
        sys.exit("REFUSED: --apply needs --approved-by with Mohamed's words")
    if any(p["chars"] > 30 for p in plan):
        sys.exit("REFUSED: a proposed name exceeds 30 characters; shorten the suffix")
    key_id, issuer, p8 = A.creds(); tok = A.token(key_id, issuer, p8)
    results = []
    for p in plan:
        body = json.dumps({"data": {"type": "appInfoLocalizations", "id": p["localization_id"], "attributes": {"name": p["new"]}}}).encode()
        req = urllib.request.Request(A.API + f"/v1/appInfoLocalizations/{p['localization_id']}", data=body, method="PATCH",
                                     headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                results.append({**p, "status": r.status})
        except urllib.error.HTTPError as e:
            results.append({**p, "status": e.code, "error": e.read().decode()[:300]})
        print(f"{results[-1]['status']}  {p['old']!r} -> {p['new']!r}")
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    (rec_dir / f"asc-rename.{ts}.json").write_text(json.dumps({"approved_by": a.approved_by, "results": results}, indent=1))


if __name__ == "__main__":
    main()
