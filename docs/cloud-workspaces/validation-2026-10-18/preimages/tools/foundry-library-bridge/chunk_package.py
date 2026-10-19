"""Local chunk preparation and explicit durable-session planning; never publish."""
import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
from pathlib import Path
from common import digest, encode, safe_path, valid_hash
from pull import no_symlink_parents, publish_exclusive

CHUNK_BYTES = 1024**2
ARCHIVE_BYTES = 4 * 1024**3
MAX_CHUNKS = 4096


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", value):
        raise ValueError("invalid project/session identifier")
    return value


def immutable_reference(reference, maximum=ARCHIVE_BYTES, unpublished=False):
    valid_hash(reference["sha256"])
    generation = reference["generation"]
    if unpublished:
        if generation is not None:
            raise ValueError("unpublished references require null generation")
    elif not isinstance(generation, str) or not re.fullmatch(r"[1-9][0-9]{0,31}", generation):
        raise ValueError("real pinned generation required")
    if (type(reference["bytes"]) is not int or not 0 < reference["bytes"] <= maximum
            or not isinstance(reference["bucket"], str)
            or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]", reference["bucket"])):
        raise ValueError("real pinned generation, bucket and bounded byte count required")
    safe_path(reference["object"])
    return reference


def chunk_reference(manifest, chunk):
    return {"bucket": manifest["bucket"], "object": "projects/" + manifest["project"] + "/objects/" + chunk["sha256"],
            "generation": chunk["generation"], "sha256": chunk["sha256"], "bytes": chunk["bytes"]}


def validate_manifest(manifest, published=False):
    if manifest.get("format") != "foundry.chunk-manifest.v1":
        raise ValueError("invalid chunk manifest format")
    if manifest.get("status") != ("published" if published else "prepared-not-published"):
        raise ValueError("chunk manifest publication status mismatch")
    identifier(manifest["project"])
    immutable_reference(manifest["sourceArchive"])
    chunks = manifest["chunks"]
    if not isinstance(chunks, list) or not 1 <= len(chunks) <= MAX_CHUNKS:
        raise ValueError("chunk count bound exceeded")
    total = 0
    generations = {}
    for chunk in chunks:
        valid_hash(chunk["sha256"])
        if type(chunk["bytes"]) is not int or not 0 < chunk["bytes"] <= CHUNK_BYTES:
            raise ValueError("invalid chunk size")
        ref = chunk_reference(manifest, chunk)
        if published:
            immutable_reference(ref, CHUNK_BYTES)
        else:
            immutable_reference(ref, CHUNK_BYTES, unpublished=True)
        # Same content-addressed object cannot have conflicting generation/size.
        identity = (chunk["generation"], chunk["bytes"])
        if generations.setdefault(chunk["sha256"], identity) != identity:
            raise ValueError("conflicting repeated chunk reference")
        total += chunk["bytes"]
    if total != manifest["sourceArchive"]["bytes"]:
        raise ValueError("chunk lengths do not cover source archive")
    if len(encode(manifest)) > CHUNK_BYTES:
        raise ValueError("manifest exceeds broker single-read bound")
    return manifest


def tasks_for(manifest, manifest_bytes):
    if type(manifest_bytes) is not int or not 0 < manifest_bytes <= CHUNK_BYTES:
        raise ValueError("manifest byte bound exceeded")
    # Conservative: every occurrence reserves a grant/read, even duplicate hashes.
    return [{"kind": "manifest", "index": None, "bytes": manifest_bytes}] + [
        {"kind": "chunk", "index": i, "bytes": chunk["bytes"]} for i, chunk in enumerate(manifest["chunks"])]


def segment_requirements(manifest, manifest_bytes):
    """Unbound requirements, NOT newly issued broker identities or authority."""
    validate_manifest(manifest, published=manifest.get("status") == "published")
    if manifest_bytes != len(encode(manifest)):
        raise ValueError("capacity requirements must use actual canonical manifest byte count")
    segments = []
    for position, task in enumerate(tasks_for(manifest, manifest_bytes)):
        if not segments or segments[-1]["bytes"] + task["bytes"] > 8 * CHUNK_BYTES or segments[-1]["grants"] >= 32:
            segments.append({"segment": len(segments), "firstTask": position, "lastTask": position,
                             "bytes": 0, "grants": 0, "reads": 0})
        segment = segments[-1]
        segment["lastTask"] = position
        segment["bytes"] += task["bytes"]
        segment["grants"] += 1
        segment["reads"] += 1
    return {"format": "foundry.chunk-session-requirements.v1", "project": manifest["project"],
            "sourceArchive": manifest["sourceArchive"], "manifestSha256": digest(manifest), "manifestBytes": manifest_bytes,
            "status": "requires-explicit-reviewed-durable-namespaces", "requiredDurableNamespaces": len(segments),
            "segments": segments, "automaticRollover": False, "historyDeletionAllowed": False}


def plan_sessions(manifest, manifest_sha256, manifest_bytes, sessions, rollover_review_ref=None):
    """Use only supplied, host-reviewed namespaces and available lifetime budgets.

    This is a conservative plan, not an atomic budget reservation or permission.
    Actual broker grants/reads remain authoritative. Never create/reset namespaces.
    """
    valid_hash(manifest_sha256)
    requirements = segment_requirements(manifest, manifest_bytes)
    if manifest_sha256 != requirements["manifestSha256"]:
        raise ValueError("capacity plan manifest hash mismatch")
    if not isinstance(sessions, list) or not sessions or len(sessions) > MAX_CHUNKS + 1:
        raise ValueError("explicit reviewed durable broker namespaces required")
    if len(sessions) > 1:
        identifier(rollover_review_ref)
    identities, stores, namespaces = set(), set(), set()
    for session in sessions:
        key = tuple(identifier(session[k]) for k in ("environment", "authorityId", "namespaceId"))
        # One authority must not be advertised as multiple independent databases.
        authority = key[:2]
        if authority in identities:
            raise ValueError("duplicate durable broker authority; namespace aliases cannot replenish lifetime budget")
        identities.add(authority)
        identifier(session["approvalRef"])
        store = (key[0], identifier(session["durableStoreRef"]))
        namespace = (key[0], key[2])
        if store in stores or namespace in namespaces:
            raise ValueError("durable namespace/store reuse cannot replenish lifetime budget")
        stores.add(store)
        namespaces.add(namespace)
        if session.get("sourceArchiveSha256") != manifest["sourceArchive"]["sha256"] or session.get("historyPreserved") is not True:
            raise ValueError("durable session must bind this archive and preserve history")
        for field, hard in (("availableBytes", 8 * CHUNK_BYTES), ("availableGrants", 32),
                            ("availableReads", 128), ("maxReadBytes", CHUNK_BYTES)):
            value = session[field]
            if type(value) is not int or not 0 <= value <= hard:
                raise ValueError("invalid remaining broker lifetime budget")
    remaining = [{k: s[k] for k in ("availableBytes", "availableGrants", "availableReads")} for s in sessions]
    assignments = []
    cursor = 0
    for task in tasks_for(manifest, manifest_bytes):
        while cursor < len(sessions):
            budget = remaining[cursor]
            if (task["bytes"] <= sessions[cursor]["maxReadBytes"] and budget["availableBytes"] >= task["bytes"]
                    and budget["availableGrants"] >= 1 and budget["availableReads"] >= 1):
                break
            cursor += 1
        if cursor == len(sessions):
            raise ValueError("insufficient reviewed grant/read/byte budget; explicit required durable namespaces: "
                             + str(requirements["requiredDurableNamespaces"]))
        budget = remaining[cursor]
        budget["availableBytes"] -= task["bytes"]
        budget["availableGrants"] -= 1
        budget["availableReads"] -= 1
        assignments.append({**task, "session": cursor})
    plan = {"format": "foundry.chunk-session-plan.v1", "status": "reviewed-capacity-plan-not-authority",
            "sourceArchive": manifest["sourceArchive"], "manifestSha256": manifest_sha256,
            "sessions": sessions, "assignments": assignments, "rolloverReviewRef": rollover_review_ref,
            "automaticRollover": False, "historyDeletionAllowed": False}
    plan["planSha256"] = digest(plan)
    return plan


def prepare(archive, reference, project, bucket, destination, sessions=None, rollover_review_ref=None):
    """Split already-held approved source bytes; no execution, recompression or upload."""
    immutable_reference(reference)
    identifier(project)
    archive, destination = no_symlink_parents(archive), no_symlink_parents(destination)
    if destination.exists() or destination.is_symlink() or not destination.parent.is_dir():
        raise ValueError("chunk package needs new destination under existing directory")
    if shutil.disk_usage(destination.parent).free < reference["bytes"] + 64 * CHUNK_BYTES:
        raise ValueError("insufficient local chunk package disk headroom")
    stage = Path(tempfile.mkdtemp(prefix=".foundry-chunks-", dir=destination.parent))
    published = False
    try:
        root = stage / "projects" / project / "objects"
        root.mkdir(parents=True, mode=0o700)
        fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        chunks, checksum, total = [], hashlib.sha256(), 0
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size != reference["bytes"]:
                raise ValueError("source archive does not match recorded size")
            while True:
                data = source.read(CHUNK_BYTES)
                if not data:
                    break
                total += len(data)
                if total > reference["bytes"] or len(chunks) >= MAX_CHUNKS:
                    raise ValueError("source archive size/chunk bound exceeded")
                checksum.update(data)
                h = hashlib.sha256(data).hexdigest()
                path = root / h
                if not path.exists():
                    with path.open("xb") as output:
                        output.write(data)
                        output.flush()
                        os.fchmod(output.fileno(), 0o400)
                        os.fsync(output.fileno())
                chunks.append({"sha256": h, "bytes": len(data), "generation": None})
        if total != reference["bytes"] or checksum.hexdigest() != reference["sha256"]:
            raise ValueError("source archive hash does not match recorded receipt")
        manifest = validate_manifest({"format": "foundry.chunk-manifest.v1", "status": "prepared-not-published", "project": project,
                                      "bucket": bucket, "sourceArchive": reference, "chunks": chunks})
        raw = encode(manifest)
        descriptor = {"format": "foundry.chunk-package.v1", "status": "prepared-not-published",
                      "project": project, "sourceArchive": reference,
                      "manifest": {"bucket": bucket, "object": "projects/" + project + "/manifests/" + hashlib.sha256(raw).hexdigest(),
                                   "generation": None, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)},
                      "publicationAuthorized": False,
                      "nextGate": "Publish approved chunks create-only, record actual generations, finalize a NEW manifest and descriptor; issue reviewed durable grants separately."}
        values = [("manifest.prepared.json", manifest), ("publication.prepared.json", descriptor),
                  ("session-requirements.json", segment_requirements(manifest, len(raw)))]
        if sessions is not None:
            plan = plan_sessions(manifest, descriptor["manifest"]["sha256"], len(raw), sessions, rollover_review_ref)
            values.append(("session-plan.prepared.json", {
                "status": "prepared-plan-recompute-after-real-generation-publication", "plan": plan}))
        for name, value in values:
            with (stage / name).open("xb") as output:
                output.write(encode(value))
                output.flush()
                os.fchmod(output.fileno(), 0o400)
                os.fsync(output.fileno())
        for directory, _, _ in os.walk(stage, topdown=False):
            os.chmod(directory, 0o500)
            directory_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        publish_exclusive(stage, destination)
        published = True
        directory_fd = os.open(destination.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return descriptor
    except Exception as error:
        reason = str(error) if isinstance(error, ValueError) else type(error).__name__
        raise RuntimeError("local chunk package published; directory acknowledgement failed" if published
                           else "chunk preparation refused; private staging retained for review: " + reason) from None


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("archive", "reference", "project", "bucket", "destination"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--sessions", help="Nonsecret explicit reviewed namespace/budget JSON list; insufficient capacity refuses publication")
    parser.add_argument("--rollover-review-ref", help="Required explicit review reference when supplying multiple durable namespaces")
    args = parser.parse_args()
    try:
        reference_path = Path(args.reference)
        if reference_path.stat().st_size > 65536:
            raise ValueError("source reference exceeds bound")
        sessions = None
        if args.sessions:
            sessions_path = Path(args.sessions)
            if sessions_path.stat().st_size > CHUNK_BYTES:
                raise ValueError("reviewed sessions metadata exceeds bound")
            sessions = json.loads(sessions_path.read_text())
        print(json.dumps(prepare(args.archive, json.loads(reference_path.read_text()), args.project, args.bucket,
                                 args.destination, sessions, args.rollover_review_ref)))
    except Exception as error:
        parser.exit(1, "Chunk preparation stopped: " + (str(error) if isinstance(error, (ValueError, RuntimeError)) else type(error).__name__) + "\n")
