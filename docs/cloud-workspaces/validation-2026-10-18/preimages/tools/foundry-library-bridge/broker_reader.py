"""Scoped broker read DI. No grant issuance, credential storage, or fleet fallback."""
import hashlib
import io
import math
import re
import time
import urllib.parse
import urllib.request
from cloud import CloudReader
from common import encode, valid_hash
from pull import no_symlink_parents
from bounded_http import BoundedHTTPTransport

BROKER_DEADLINE_SECONDS = 1800
BROKER_READ_BYTES = 64 * 1024


def remaining_timeout(deadline):
    if type(deadline) not in (int, float) or not math.isfinite(deadline):
        raise ValueError("valid absolute broker deadline required")
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise RuntimeError("broker absolute deadline exceeded")
    return min(30.0, remaining)


class BrokerReader(CloudReader):
    """Host supplies trusted binding lookup and an opaque credential reference.

    binding_for(reference) returns {reference, grantId, requestId} only after
    independently checking the issued grant's exact bucket/object/generation/hash/
    bytes binding. This lookup cannot be supplied by a browser or fleet catalog.
    resolve_credential(reference) returns the existing executor bearer in memory.
    """
    def __init__(self, endpoint, credential_reference, resolve_credential, binding_for, cache, bounded_transport=None):
        url = urllib.parse.urlsplit(endpoint)
        if (url.scheme != "https" or not url.hostname or url.username is not None or url.password is not None
                or url.path != "/v1/broker/read" or url.query or url.fragment):
            raise ValueError("trusted HTTPS broker read endpoint required")
        self.endpoint = endpoint
        self.credential_reference = credential_reference
        self.resolve_credential = resolve_credential
        self.binding_for = binding_for
        self.cache = no_symlink_parents(cache)
        self.via = None
        # Construction is trusted host DI (explicit endpoint, credential resolver
        # and issued-grant lookup), never a browser-controlled activation flag.
        # The concrete stdlib supervisor starts a child only on an approved read.
        self.bounded_transport = (BoundedHTTPTransport(endpoint) if bounded_transport is None else bounded_transport)

    def fetch(self, reference):
        # Check before inherited cache lookup too: cache is never authorization.
        if self.bounded_transport is None:
            raise RuntimeError("trusted absolute-deadline bounded broker transport required")
        self._binding(reference)
        return super().fetch(reference)

    def _binding(self, reference):
        if type(reference.get("bytes")) is not int or not 0 <= reference["bytes"] <= 1024**2:
            raise ValueError("broker single-read bound is 1 MiB; use a published pinned chunk package with reviewed durable capacity")
        valid_hash(reference["sha256"])
        try:
            binding = self.binding_for(dict(reference))
            if binding["reference"] != reference:
                raise ValueError()
            for key in ("grantId", "requestId"):
                if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,95}", binding[key]):
                    raise ValueError()
            return {key: binding[key] for key in ("grantId", "requestId")}
        except Exception:
            raise ValueError("no trusted issued grant binding for exact immutable object; namespace mapping not inferred") from None

    def stream_to(self, reference, stream, deadline=None):
        """Use a trusted transport port; urllib per-operation timeout is NOT proof.

        Port open(request, deadline=ABS, timeout=REMAINING_CAPPED_30,
        max_response_bytes=EXPECTED_BYTES) returns a bounded response with status, final_url,
        read(size, deadline=ABS, timeout=REMAINING_CAPPED_30), and
        close(deadline=ABS, timeout=NONNEGATIVE_REMAINING_CAPPED_30).
        The host must prove the port enforces the absolute deadline across open,
        handshake, redirect refusal, body reads, abort and close, and bounds
        allocation BEFORE I/O. Expired close must abort without waiting. Neither
        an arbitrary callback nor this client's post-call clock checks provide
        that proof. Default is the concrete supervised stdlib transport; a removed
        or unsupported port fails before credential resolution or network.
        """
        if self.bounded_transport is None:
            raise RuntimeError("trusted absolute-deadline bounded broker transport port required; no urllib fallback")
        now = time.monotonic()
        if deadline is None:
            deadline = now + BROKER_DEADLINE_SECONDS
        remaining_timeout(deadline)
        deadline = min(deadline, now + BROKER_DEADLINE_SECONDS)
        response = None
        try:
            body = self._binding(reference)
            remaining_timeout(deadline)
            token = self.resolve_credential(self.credential_reference)
            remaining_timeout(deadline)
            if (not isinstance(token, str) or not 32 <= len(token) <= 8192
                    or not re.fullmatch(r"[A-Za-z0-9._~+/-]{32,}=*", token)):
                raise ValueError()
            request = urllib.request.Request(self.endpoint, data=encode(body), method="POST",
                headers={"Authorization": "Bearer " + token, "Content-Type": "application/json",
                         "Accept-Encoding": "identity"})
            response = self.bounded_transport.open(request, deadline=deadline, timeout=remaining_timeout(deadline),
                                                   max_response_bytes=reference["bytes"])
            remaining_timeout(deadline)
            if response.status != 200 or response.final_url != self.endpoint:
                raise ValueError()
            checksum, size, verified = hashlib.sha256(), 0, io.BytesIO()
            while True:
                requested = min(BROKER_READ_BYTES, reference["bytes"] - size + 1)
                data = response.read(requested, deadline=deadline, timeout=remaining_timeout(deadline))
                remaining_timeout(deadline)
                if type(data) is not bytes or len(data) > requested:
                    raise ValueError()
                if not data:
                    break
                size += len(data)
                if size > reference["bytes"]:
                    raise ValueError()
                checksum.update(data)
                verified.write(data)
                remaining_timeout(deadline)
            if size != reference["bytes"] or checksum.hexdigest() != reference["sha256"]:
                raise ValueError()
            # At most 1 MiB; rejected broker content never reaches cache/staging.
            remaining_timeout(deadline)
            stream.write(verified.getvalue())
            remaining_timeout(deadline)
        except Exception:
            raise RuntimeError("scoped broker read refused, deadline exceeded or integrity mismatch; no fallback") from None
        finally:
            if response is not None:
                try:
                    response.close(deadline=deadline, timeout=max(0.0, min(30.0, deadline - time.monotonic())))
                    remaining_timeout(deadline)
                except Exception:
                    raise RuntimeError("bounded broker close/deadline acknowledgement failed; no fallback") from None

    def authorize_cached(self, reference):
        # Replay the SAME host-provided request ID through current broker checks.
        # Never turn local cached bytes into an authorization bypass.
        self.stream_to(reference, io.BytesIO())
