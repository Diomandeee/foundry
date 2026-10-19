"""Assemble a browse catalog from existing verified receipts; no cloud calls."""
import argparse
import gzip
import hashlib
import json
from collections import defaultdict
from pathlib import Path
from common import digest, encode, file_hash, safe_path, validate_entries


def build(copy_root, proposals_path, output):
    copy_root, output = Path(copy_root), Path(output)
    if output.exists():
        raise ValueError("output already exists; use a new revision directory")
    source_bytes = (copy_root / "SOURCE-CATALOG.json").read_bytes()
    source = json.loads(source_bytes)
    run = json.loads((copy_root / "RUN.json").read_text())
    anchor = next(r for r in run["finalMetadataReceipts"] if r["object"].endswith("/SOURCE-CATALOG.json"))
    if hashlib.sha256(source_bytes).hexdigest() != anchor["sha256"] or len(source_bytes) != anchor["bytes"]:
        raise ValueError("source catalog does not match transfer receipt")
    proposed = json.loads(Path(proposals_path).read_text())
    exceptions = json.loads((copy_root / "REMAINING-EXCEPTIONS-v2.json").read_text())
    snapshots = list(source["hosts"].values()) + source["recoveries"]
    by_name = {Path(s["archive"]).name: s for s in snapshots}
    archives, rows, states, source_changes = {}, defaultdict(list), defaultdict(dict), defaultdict(list)
    for name in source["restoreOrder"]:
        snapshot = by_name[name]
        obj = next(o for o in snapshot["objects"] if o["object"].endswith(".tar.gz"))
        manifest = next(o for o in snapshot["objects"] if o["object"].endswith("-SOURCE-MANIFEST.jsonl.gz"))
        local = copy_root / Path(manifest["object"]).name
        if file_hash(local) != manifest["sha256"] or local.stat().st_size != manifest["bytes"]:
            raise ValueError("source manifest does not match transfer receipt")
        archive_id = digest({"bucket": source["bucket"], **obj})
        archives[archive_id] = {"bucket": source["bucket"], **obj}
        host = snapshot["host"]
        with gzip.open(local, "rt") as stream:
            for line in stream:
                row = json.loads(line)
                if row.get("status") != "copied":
                    continue
                name = safe_path(row["path"])
                entry = {"sourcePath": name, "archive": archive_id,
                         "sha256": row["sha256"], "bytes": row["bytes"],
                         "mode": row["mode"] & 0o777, "mtimeNs": row.get("mtimeNs")}
                old = states[host].get(name)
                if old and (old["sha256"], old["mode"]) != (entry["sha256"], entry["mode"]):
                    source_changes[(host, name)].append(old)
                states[host][name] = entry
                rows[host].append(name)
    identities, covered = [], set()
    for p in proposed:
        identities.append({"id": p["id"], "title": p["title"], "family": p["family"],
                           "identityConfidence": p["identityConfidence"], "members": p["members"]})
    # Every delivered file remains browsable, including files outside recognized repositories.
    for p in identities:
        for member in p["members"]:
            host, prefix = member.split(":", 1)
            for path in states[host]:
                if path.startswith(prefix + "/"):
                    covered.add((host, path))
    extra = defaultdict(set)
    for host, entries in states.items():
        for path in entries:
            if (host, path) not in covered:
                parts = path.split("/")
                prefix = "/".join(parts[:2]) if len(parts) > 2 else parts[0]
                extra[(host, prefix)].add(path)
    for (host, prefix), names in sorted(extra.items()):
        identities.append({"id": "directory-" + digest([host, prefix])[:20],
                           "title": prefix + " (uncatalogued source)",
                           "family": "directory:" + host + ":" + prefix,
                           "identityConfidence": "directory-collection", "members": [host + ":" + prefix],
                           "onlyPaths": sorted(names)})
    output.mkdir(parents=True)
    (output / "projects").mkdir()
    summaries, total_versions, blocked = [], 0, 0
    for identity in identities:
        versions = []
        held = []
        for member in identity["members"]:
            host, prefix = member.split(":", 1)
            member_held = [e for e in exceptions if e["host"] == host and
                           (e["path"] == prefix or e["path"].startswith(prefix + "/"))]
            held.extend(member_held)
            allowed = set(identity.get("onlyPaths", []))
            entries = []
            changes = []
            for name, entry in sorted(states[host].items()):
                if not name.startswith(prefix + "/") or (allowed and name not in allowed):
                    continue
                entries.append({**entry, "path": name[len(prefix) + 1:]})
                for old in source_changes.get((host, name), []):
                    changes.append({**old, "path": name[len(prefix) + 1:]})
            if not entries:
                continue
            # Keep changed captures as individually selectable historical observations.
            observations = [(entries, "assembled-copy")]
            if changes:
                observations.extend(([e], "earlier-file-observation") for e in changes)
            for payload, kind in observations:
                version = {"member": member, "kind": kind, "entries": payload,
                           "files": len(payload), "bytes": sum(e["bytes"] for e in payload),
                           "captureChanged": bool(changes), "heldPaths": member_held}
                version["id"] = digest(version)
                try:
                    validate_entries(payload)
                    version["pullBlocked"] = None
                except ValueError as error:
                    version["pullBlocked"] = str(error)
                    blocked += 1
                versions.append(version)
        assembled = [v for v in versions if v["kind"] == "assembled-copy"]
        maps = {v["id"]: {e["path"]: (e["sha256"], e["mode"]) for e in v["entries"]} for v in assembled}
        path_signatures, presence = defaultdict(set), defaultdict(int)
        for mapping in maps.values():
            for path, signature in mapping.items():
                path_signatures[path].add(signature)
                presence[path] += 1
        comparison = {}
        for version_id, mapping in maps.items():
            comparison[version_id] = {
                "uniquePaths": sum(presence[p] == 1 for p in mapping) if len(maps) > 1 else 0,
                "pathsAbsentFromThisCopy": len(path_signatures.keys() - mapping.keys()),
                "conflictingPaths": [p for p in mapping if len(path_signatures[p]) > 1]}
        candidates = [v for v in assembled if not v["pullBlocked"] and not v["captureChanged"]
                      and all(all(maps[v["id"]].get(k) == val for k, val in other.items()) for other in maps.values())]
        default = sorted(candidates, key=lambda v: v["member"])[0]["id"] if candidates else None
        reason = ("Contains every observed source path with matching bytes and permissions; identical candidates use stable member order."
                  if default else "No conflict-free superset established; choose a preserved version explicitly." if versions
                  else "No delivered source files for this inventory entry.")
        project = {k: v for k, v in identity.items() if k != "onlyPaths"}
        project.update(versions=versions, defaultVersion=default, canonicalVersion=None, defaultReason=reason,
                       heldPaths=held, comparison=comparison)
        raw = encode(project)
        detail_hash = hashlib.sha256(raw).hexdigest()
        (output / "projects" / (detail_hash + ".json")).write_bytes(raw)
        summaries.append({"id": identity["id"], "title": identity["title"], "family": identity["family"],
                          "identityConfidence": identity["identityConfidence"], "versions": len(assembled),
                          "machines": sorted({v["member"].split(":")[0] for v in assembled}),
                          "defaultVersion": default, "defaultReason": reason, "detailSha256": detail_hash,
                          "heldPaths": len(held),
                          "files": max((v["files"] for v in assembled), default=0)})
        total_versions += len(versions)
    index = {"format": "foundry.fleet-catalog.v1", "sourceCatalog": {"bucket": source["bucket"], **anchor},
             "captured": source["started"], "archives": archives, "projects": summaries,
             "scope": "Source/support only; no complete Git history, credentials, dependencies or data backup.",
             "uniqueDeliveredPaths": sum(len(s) for s in states.values()),
             "heldPathCount": len(exceptions),
             "canonicalAuthority": False, "cloudPublished": False}
    index["revision"] = digest(index)
    (output / "catalog.json").write_bytes(encode(index))
    receipt = {"revision": index["revision"], "projectEntries": len(summaries), "versions": total_versions,
               "deliveredPaths": index["uniqueDeliveredPaths"], "blockedVersions": blocked,
               "captureChangedPaths": len(source_changes), "archives": len(archives),
               "cloudCalls": 0, "testsRun": False, "proposalsSha256": file_hash(proposals_path)}
    (output / "ASSEMBLY-RECEIPT.json").write_bytes(encode(receipt))
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--copy-root", required=True)
    parser.add_argument("--proposals", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.copy_root, args.proposals, args.output)))
