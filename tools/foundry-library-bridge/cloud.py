"""Read-only GCS transport using an existing, explicitly pinned CLI login."""
import hashlib
import json
import os
import re
import selectors
import shlex
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from common import valid_hash
from cache_budget import BoundedDownload, CacheBudget
from pull import publish_exclusive


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class CloudReader:
    def __init__(self, project, account, cache, via=None):
        if not re.fullmatch(r"[a-z][a-z0-9-]{4,61}[a-z0-9]", project):
            raise ValueError("an explicit GCP project is required")
        if not account or account.startswith("-") or any(c.isspace() for c in account):
            raise ValueError("an explicit existing Google account is required")
        self.project, self.account = project, account
        if via not in (None, "mac1"):
            raise ValueError("the only prepared SSH read relay is mac1")
        self.via = via
        self.cache = Path(os.path.abspath(cache))
        for part in (self.cache, *self.cache.parents):
            if part.is_symlink():
                raise ValueError("archive cache parent must not be a symlink")
        self.gcloud = shutil.which("gcloud")
        if not self.gcloud and Path("/opt/homebrew/bin/gcloud").is_file():
            self.gcloud = "/opt/homebrew/bin/gcloud"
        if not self.gcloud and not via:
            raise ValueError("gcloud is unavailable; installation remains an owner gate")
        self.opener = urllib.request.build_opener(NoRedirect())

    def token(self):
        result = subprocess.run([self.gcloud, "auth", "print-access-token", "--account=" + self.account,
                                 "--project=" + self.project, "--quiet"],
                                capture_output=True, timeout=45, check=False)
        if result.returncode or not result.stdout.strip():
            raise RuntimeError("existing Google login could not supply credentials; no login or secret change attempted")
        return result.stdout.decode().strip()

    def fetch(self, reference):
        h = valid_hash(reference["sha256"])
        generation = reference["generation"]
        expected = reference["bytes"]
        bucket = reference["bucket"]
        if (not isinstance(generation, str) or not generation.isdigit()
                or type(expected) is not int or expected < 0 or expected > 4 * 1024**3
                or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]", bucket)):
            raise ValueError("invalid immutable object reference")
        self.cache.mkdir(parents=True, exist_ok=True, mode=0o700)
        target = self.cache / (h + ".tar.gz")
        with CacheBudget(self.cache).locked(exclusive=True) as budget:
            # Full bounded inventory and capacity observation precede all transport,
            # including broker reauthorization/reassembly of a cache hit.
            budget.admit(0, new_file=False)
            if target.name in budget.files:
                if budget.verified(target.name, expected, h):
                    self.authorize_cached(reference)
                    return target
                raise ValueError("cached archive is corrupt; retained for operator review")
            budget.admit(expected)
            fd, partial = tempfile.mkstemp(prefix=".download-", dir=self.cache)
            with os.fdopen(fd, "wb") as stream:
                os.fchmod(stream.fileno(), 0o600)
                bounded = BoundedDownload(stream, expected)
                if self.via:
                    self.ssh_to(reference, bounded)
                else:
                    self.stream_to(reference, bounded)
                stream.flush()
                os.fsync(stream.fileno())
            # Every transport passes through the same complete archive check.
            if not budget.verified(Path(partial).name, expected, h):
                raise ValueError("archive bytes do not match pinned receipt")
            budget.admit(0, new_file=False)
            # Rename consumes the admitted staging file, with no extra archive copy,
            # no overwrite and no unlink/cleanup. Failed partials remain charged.
            publish_exclusive(Path(partial), target)
            os.fsync(budget.fd)
            return target

    def cache_metadata(self):
        return CacheBudget(self.cache).observe()

    def authorize_cached(self, reference):
        """Direct/SSH cache is local content; scoped transports may require fresh authorization."""
        pass

    def stream_to(self, reference, stream):
        query = urllib.parse.urlencode({"alt": "media", "generation": reference["generation"]})
        url = ("https://storage.googleapis.com/storage/v1/b/" + urllib.parse.quote(reference["bucket"], safe="")
               + "/o/" + urllib.parse.quote(reference["object"], safe="") + "?" + query)
        request = urllib.request.Request(url, headers={"Authorization": "Bearer " + self.token(),
                                                       "Accept-Encoding": "identity"})
        try:
            response = self.opener.open(request, timeout=60)
        except urllib.error.HTTPError as error:
            code = error.code
            error.close()
            raise RuntimeError("GCS archive read refused (HTTP %d); no fallback generation used" % code) from None
        except (urllib.error.URLError, TimeoutError):
            raise RuntimeError("GCS archive read unavailable; retry the same pinned revision") from None
        with response:
            if response.status != 200:
                raise RuntimeError("unexpected GCS response")
            received_generation = response.headers.get("x-goog-generation")
            if received_generation is not None and received_generation != reference["generation"]:
                raise ValueError("GCS generation mismatch")
            checksum, size, start = hashlib.sha256(), 0, time.monotonic()
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > reference["bytes"] or time.monotonic() - start > 1800:
                    raise ValueError("archive download exceeded declared bound")
                checksum.update(chunk)
                stream.write(chunk)
            if size != reference["bytes"] or checksum.hexdigest() != reference["sha256"]:
                raise ValueError("archive bytes do not match pinned receipt")

    def ssh_to(self, reference, stream):
        helper = "/Users/mohameddiomande/Developer/foundry-integration/source/tools/foundry-library-bridge/ssh_reader.py"
        command = shlex.join(["/opt/homebrew/bin/python3", helper, "--gcp-project", self.project, "--account", self.account])
        process = subprocess.Popen(["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                                    "-o", "ClearAllForwardings=yes", "-o", "ServerAliveInterval=15",
                                    "-o", "ServerAliveCountMax=3", self.via, command],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            process.stdin.write(json.dumps(reference).encode() + b"\n")
            process.stdin.close()
            h, size, start = hashlib.sha256(), 0, time.monotonic()
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    if time.monotonic() - start > 1800:
                        raise RuntimeError("SSH archive read deadline exceeded")
                    if not selector.select(10):
                        continue
                    data = os.read(process.stdout.fileno(), 1024 * 1024)
                    if not data:
                        break
                    size += len(data)
                    if size > reference["bytes"]:
                        raise ValueError("SSH archive stream exceeded declared size")
                    h.update(data)
                    stream.write(data)
            if process.wait(timeout=10) or size != reference["bytes"] or h.hexdigest() != reference["sha256"]:
                raise RuntimeError("SSH relay unavailable or archive verification failed; no credentials copied")
        finally:
            if not process.stdin.closed:
                process.stdin.close()
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            process.stdout.close()
