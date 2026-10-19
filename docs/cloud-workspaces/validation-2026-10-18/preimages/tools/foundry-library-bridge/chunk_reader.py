"""Granted, bounded reassembly of explicitly published pinned chunk packages."""
import hashlib
import io
import json
import time
from broker_reader import BrokerReader
from chunk_package import CHUNK_BYTES, chunk_reference, identifier, immutable_reference, plan_sessions, validate_manifest
from cloud import CloudReader
from common import digest, encode
from pull import no_symlink_parents


class Discard:
    def write(self, data):
        return len(data)


class ChunkReader(CloudReader):
    """Trusted host DI only; never takes grants, namespaces or credentials from HTTP.

    package_for(expected_source) returns {descriptor, manifestBytes, sessions,
    rolloverReviewRef}. The manifest bytes must be loaded with a <=1MiB bound by
    the host, and are independently hash-checked here. descriptor must be an
    approved published receipt, not a preparation template. It pins the actual
    manifest generation/hash, project and original source reference.

    broker_for(session, package_digest, task, expected_object) returns a scoped
    BrokerReader. Host lookup must verify current durable namespace identity,
    reviewed rollover, exact task.planSha256 approval, issued grant/provider binding
    and stable request ID. Capacity plans are pinned per reader, not authorization.
    It must not create/reset namespaces, issue grants or substitute transports.
    """
    def __init__(self, package_for, broker_for, cache):
        self.package_for = package_for
        self.broker_for = broker_for
        self.cache = no_symlink_parents(cache)
        self.via = None
        self._packages = {}
        self._manifest_bytes = 0

    def _load(self, reference):
        immutable_reference(reference)
        key = digest(reference)
        if key in self._packages:
            return self._packages[key]
        try:
            bundle = self.package_for(dict(reference))
            # Snapshot inert JSON to prevent caller mutation after validation.
            descriptor = json.loads(encode(bundle["descriptor"]))
            raw = bundle["manifestBytes"]
            if type(raw) is not bytes or not 0 < len(raw) <= CHUNK_BYTES:
                raise ValueError()
            if (descriptor["format"] != "foundry.chunk-package.v1" or descriptor["status"] != "published"
                    or descriptor.get("publicationAuthorized") is False or descriptor["sourceArchive"] != reference):
                raise ValueError()
            project = identifier(descriptor["project"])
            manifest_ref = immutable_reference(descriptor["manifest"], CHUNK_BYTES)
            if (manifest_ref["object"] != "projects/" + project + "/manifests/" + manifest_ref["sha256"]
                    or manifest_ref["bytes"] != len(raw)
                    or hashlib.sha256(raw).hexdigest() != manifest_ref["sha256"]):
                raise ValueError()
            manifest = validate_manifest(json.loads(raw), published=True)
            if (raw != encode(manifest) or manifest["project"] != project or manifest["sourceArchive"] != reference
                    or manifest["bucket"] != manifest_ref["bucket"]):
                raise ValueError()
            sessions = json.loads(encode(bundle["sessions"]))
            plan = plan_sessions(manifest, manifest_ref["sha256"], len(raw), sessions, bundle.get("rolloverReviewRef"))
            if len(self._packages) >= 128 or self._manifest_bytes + len(raw) > 16 * CHUNK_BYTES:
                raise ValueError()
            result = descriptor, manifest, raw, plan
            self._packages[key] = result
            self._manifest_bytes += len(raw)
            return result
        except Exception:
            raise ValueError("published pinned chunk package and sufficient explicitly reviewed durable namespace budgets required") from None

    def preflight(self, references):
        used, stores, namespaces = set(), set(), set()
        for reference in references:
            _, _, _, plan = self._load(reference)
            for session in plan["sessions"]:
                key = (session["environment"], session["authorityId"])
                store = (session["environment"], session["durableStoreRef"])
                namespace = (session["environment"], session["namespaceId"])
                if key in used or store in stores or namespace in namespaces:
                    raise ValueError("archives require independent reviewed durable broker namespaces; shared capacity is not assumed")
                used.add(key)
                stores.add(store)
                namespaces.add(namespace)

    def fetch(self, reference):
        # Validate package and lifetime plan even before local cache reuse.
        self._load(reference)
        return super().fetch(reference)

    def _granted(self, descriptor, plan, task, reference, deadline):
        try:
            if time.monotonic() >= deadline:
                raise ValueError()
            session = json.loads(encode(plan["sessions"][task["session"]]))
            binding = {**task, "planSha256": plan["planSha256"]}
            reader = self.broker_for(session, digest(descriptor), binding, dict(reference))
            if not isinstance(reader, BrokerReader):
                raise ValueError()
            if time.monotonic() >= deadline:
                raise ValueError()
            stream = io.BytesIO()
            # Direct stream: no per-chunk disk cache, no direct/SSH fallback.
            # BrokerReader resolves an existing exact grant and authenticates the POST.
            reader.stream_to(reference, stream, deadline=deadline)
            if time.monotonic() >= deadline:
                raise ValueError()
            data = stream.getvalue()
            if len(data) != reference["bytes"] or hashlib.sha256(data).hexdigest() != reference["sha256"]:
                raise ValueError()
            return data
        except Exception:
            raise RuntimeError("granted chunk/manifest unavailable or mismatched; namespace rollover and fallback refused") from None

    def stream_to(self, reference, stream):
        deadline = time.monotonic() + 1800
        descriptor, manifest, raw, plan = self._load(reference)
        # Verify actual granted manifest bytes before issuing any chunk read.
        actual = self._granted(descriptor, plan, plan["assignments"][0], descriptor["manifest"], deadline)
        if actual != raw:
            raise ValueError("granted manifest differs from pinned package")
        checksum, total = hashlib.sha256(), 0
        for task in plan["assignments"][1:]:
            if time.monotonic() > deadline:
                raise RuntimeError("chunk reassembly deadline exceeded; no namespace rollover attempted")
            chunk = manifest["chunks"][task["index"]]
            data = self._granted(descriptor, plan, task, chunk_reference(manifest, chunk), deadline)
            if time.monotonic() > deadline:
                raise RuntimeError("chunk reassembly deadline exceeded; no namespace rollover attempted")
            total += len(data)
            if total > reference["bytes"]:
                raise ValueError("reassembled archive exceeded pinned size")
            checksum.update(data)
            stream.write(data)
        if total != reference["bytes"] or checksum.hexdigest() != reference["sha256"]:
            raise ValueError("complete reassembled archive hash/size mismatch")
        # Inherited fetch also verifies staged archive SHA/size before no-overwrite cache publication.

    def authorize_cached(self, reference):
        # Actual granted manifest + chunks are reauthorized and verified on cache hits.
        # A discard sink bounds memory; never buffer an archive in memory.
        self.stream_to(reference, Discard())
