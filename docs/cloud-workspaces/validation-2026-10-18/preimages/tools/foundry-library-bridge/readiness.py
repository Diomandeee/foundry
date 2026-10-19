"""Conservative source coverage; operator metadata is not durable authority."""
import re
from common import digest, safe_path, valid_hash


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", value):
        raise ValueError("invalid metadata identifier")
    return value


def reconstructability(catalog, project, version, metadata=None):
    # No name, origin normalization, timestamp, or suggested-copy inference.
    result = {"state": "unknown", "ready": False, "requiredInputs": [],
              "dependencies": [], "heldMissing": [], "lineage": None,
              "reasons": ["Build contracts and durable approval evidence are not verified by this bridge."]}
    for _ in version.get("heldPaths", []):
        # Do not expose raw exception objects, provider paths, or arbitrary values.
        result["heldMissing"].append({"reason": "held-or-unavailable-in-source-copy"})
    if not metadata:
        result["reasons"].append("No explicit operator-approved reconstructability metadata supplied.")
        if result["heldMissing"] or version.get("pullBlocked") or version.get("kind") != "assembled-copy":
            result["state"] = "incomplete"
        return result
    if (metadata.get("format") != "foundry.reconstructability.v1"
            or metadata.get("catalogRevision") != catalog.index["revision"]
            or metadata.get("project") != project["id"] or metadata.get("version") != version["id"]):
        raise ValueError("reconstructability metadata binding mismatch")
    approval = identifier(metadata["approvalRef"])
    result["metadataSha256"] = digest(metadata)
    result["approvalRef"] = approval
    lineage = metadata.get("lineage")
    if lineage is not None:
        revision = lineage["revision"]
        if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", revision):
            raise ValueError("invalid explicit repository revision")
        result["lineage"] = {"repositoryId": identifier(lineage["repositoryId"]),
                             "revision": revision, "approvalRef": approval,
                             "authorityVerified": False}
    entries = {e["path"]: e for e in version["entries"]}
    for required in metadata["requiredInputs"]:
        path = safe_path(required["path"])
        h = valid_hash(required["sha256"])
        size = required["bytes"]
        if type(size) is not int or not 0 <= size <= 256 * 1024**2:
            raise ValueError("invalid required input size")
        entry = entries.get(path)
        present = bool(entry and entry["sha256"] == h and entry["bytes"] == size)
        result["requiredInputs"].append({"path": path, "sha256": h, "bytes": size,
                                          "state": "captured" if present else "missing-or-different"})
        if not present:
            result["heldMissing"].append({"path": path, "reason": "required-input-missing-or-different"})
    for dependency in metadata["dependencies"]:
        # Presence in a declaration is not evidence of installed/resolvable bytes.
        result["dependencies"].append({"id": identifier(dependency["id"]),
                                         "required": True, "state": "unknown"})
    for missing in metadata["heldMissing"]:
        result["heldMissing"].append({"path": safe_path(missing["path"]),
                                      "reason": identifier(missing["reason"])})
    if result["heldMissing"] or version.get("pullBlocked") or version.get("kind") != "assembled-copy":
        result["state"] = "incomplete"
    result["reasons"].append("Declarations do not prove dependency availability or successful reconstruction.")
    return result
