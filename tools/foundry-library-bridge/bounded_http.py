"""Supervised one-shot HTTPS broker reads. Import/construction starts no child."""
import base64
import http.client
import json
import math
import multiprocessing
import os
import struct
import sys
import threading
import time
import urllib.parse
from dataclasses import dataclass
from multiprocessing.connection import wait

MAX_BODY = 1024**2
MAX_REQUEST = 64 * 1024
MAX_PACKET = 2 * 1024**2
READ_BYTES = 64 * 1024
_SLOTS = threading.BoundedSemaphore(2)
_GUARD = threading.Lock()
_OWNED = []
_OWNER_PID = os.getpid()


def _left(deadline):
    if type(deadline) not in (int, float) or not math.isfinite(deadline):
        raise RuntimeError("bounded HTTPS deadline invalid")
    left = deadline - time.monotonic()
    if left <= 0:
        raise RuntimeError("bounded HTTPS deadline exceeded")
    return left


def _endpoint(value):
    url = urllib.parse.urlsplit(value)
    if (url.scheme != "https" or not url.hostname or url.username is not None or url.password is not None
            or url.path != "/v1/broker/read" or url.query or url.fragment):
        raise ValueError("explicit trusted HTTPS broker endpoint required")
    if url.port is not None and not 1 <= url.port <= 65535:
        raise ValueError("invalid broker port")
    return url


@dataclass(eq=False)
class _OwnedChild:
    owner: int
    process: object = None
    pid: object = None
    start_attempted: bool = False
    failed_before_start: bool = False
    released: bool = False
    confirmed_dead: bool = False


def _dead(record):
    if record.owner != os.getpid():
        return False
    if record.confirmed_dead:
        return True
    if record.failed_before_start and not record.start_attempted:
        return True
    process = record.process
    if process is None or record.pid is None or process.pid != record.pid:
        return False
    if process.exitcode is None:
        return False
    process.join(timeout=0)
    return not process.is_alive()


def _release_dead(record):
    if not _dead(record):
        return False
    with _GUARD:
        record.confirmed_dead = True
        if not record.released:
            record.released = True
            if record in _OWNED:
                _OWNED.remove(record)
            _SLOTS.release()
    return True


def _reserve():
    if _OWNER_PID != os.getpid():
        raise RuntimeError("bounded HTTPS supervisor cannot be reused after parent fork")
    with _GUARD:
        records = list(_OWNED)
    for record in records:
        try:
            _release_dead(record)
        except Exception:
            pass  # Unconfirmed liveness keeps its slot, never creates capacity.
    if not _SLOTS.acquire(blocking=False):
        raise RuntimeError("bounded HTTPS child capacity unavailable")
    record = _OwnedChild(os.getpid())
    with _GUARD:
        _OWNED.append(record)
    return record


def _stop_owned(record):
    """Bounded TERM/KILL/join of this supervisor's exact child only.

    An unconfirmed stop remains tracked and charged; no late result is accepted.
    This is not a provider stop receipt or a guarantee against OS D-state stalls.
    """
    process = record.process
    if (record.owner != os.getpid() or process is None or record.pid is None
            or process.pid != record.pid or record.pid == os.getpid()):
        return False
    try:
        if _dead(record):
            return True
        process.terminate()
        process.join(timeout=0.25)
        if not _dead(record):
            process.kill()
            process.join(timeout=0.25)
        return _dead(record)
    except Exception:
        return False


def _child_recv(pipe, maximum):
    # Child-side blocking is supervised by the parent's absolute deadline.
    def exact(count):
        result = bytearray()
        while len(result) < count:
            data = os.read(pipe.fileno(), min(READ_BYTES, count - len(result)))
            if not data:
                raise RuntimeError("private pipe closed")
            result.extend(data)
        return bytes(result)
    size = struct.unpack("!I", exact(4))[0]
    if size > maximum:
        raise RuntimeError("private pipe bound exceeded")
    return exact(size)


def _child_send(pipe, payload):
    if len(payload) > MAX_PACKET:
        raise RuntimeError("private pipe bound exceeded")
    framed = struct.pack("!I", len(payload)) + payload
    offset = 0
    while offset < len(framed):
        count = os.write(pipe.fileno(), framed[offset:offset + READ_BYTES])
        if count <= 0:
            raise RuntimeError("private pipe closed")
        offset += count


def _post_child(pipe):
    """No argv/env/file transport for credentials; no logging or retries."""
    connection = None
    try:
        _child_send(pipe, b"ready")
        packet = json.loads(_child_recv(pipe, MAX_REQUEST))
        if set(packet) != {"endpoint", "headers", "body", "deadline", "maximum"}:
            raise ValueError()
        url = _endpoint(packet["endpoint"])
        deadline, maximum = packet["deadline"], packet["maximum"]
        if type(maximum) is not int or not 0 <= maximum <= MAX_BODY:
            raise ValueError()
        headers = packet["headers"]
        if not isinstance(headers, dict) or set(headers) != {"authorization", "content-type", "accept-encoding"}:
            raise ValueError()
        if any(not isinstance(v, str) or len(v) > 8192 or any(ord(c) < 32 or ord(c) == 127 for c in v)
               for v in headers.values()):
            raise ValueError()
        if headers["content-type"] != "application/json" or headers["accept-encoding"] != "identity":
            raise ValueError()
        body = base64.b64decode(packet["body"], validate=True)
        if len(body) > 32768:
            raise ValueError()
        import ssl
        # http.client makes one direct connection. No urllib proxy discovery,
        # redirect handling, credential files, debug logging or SDK is involved.
        connection = http.client.HTTPSConnection(url.hostname, url.port or 443,
            timeout=min(30.0, _left(deadline)), context=ssl.create_default_context())
        connection.set_debuglevel(0)
        connection.connect()
        connection.sock.settimeout(min(30.0, _left(deadline)))
        connection.request("POST", url.path, body=body, headers=headers)
        connection.sock.settimeout(min(30.0, _left(deadline)))
        response = connection.getresponse()
        _left(deadline)
        received_headers = response.getheaders()
        if sum(len(k) + len(v) for k, v in received_headers) > 16384:
            raise ValueError()
        lengths = response.headers.get_all("content-length", [])
        encodings = response.headers.get_all("transfer-encoding", [])
        if (len(lengths) > 1 or len(encodings) > 1 or (lengths and encodings)
                or (lengths and (not lengths[0].isdigit() or len(lengths[0]) > 20 or int(lengths[0]) > maximum))
                or (encodings and encodings[0].casefold() != "chunked")
                or response.headers.get("content-encoding", "identity").casefold() != "identity"):
            raise ValueError()
        kept = {k.casefold(): v for k, v in received_headers if k.casefold() in
                {"content-type", "content-length", "cache-control", "x-content-type-options"}}
        data, size = [], 0
        if response.status == 200:
            while True:
                if connection.sock is not None:
                    connection.sock.settimeout(min(30.0, _left(deadline)))
                chunk = response.read(min(READ_BYTES, maximum - size + 1))
                _left(deadline)
                if not chunk:
                    break
                size += len(chunk)
                if size > maximum:
                    raise ValueError()
                data.append(chunk)
        # Non-200/redirect bodies and nonallowlisted headers are never returned.
        result = {"ok": True, "status": response.status, "headers": kept,
                  "body": base64.b64encode(b"".join(data)).decode("ascii")}
        response.close()
        connection.close()
        connection = None
        _left(deadline)
        _child_send(pipe, json.dumps(result, separators=(",", ":")).encode("utf-8"))
    except BaseException:
        try:
            _child_send(pipe, b'{"ok":false,"code":"bounded-https-refused"}')
        except BaseException:
            pass
    finally:
        if connection is not None:
            try:
                connection.close()
            except BaseException:
                pass
        pipe.close()


def _parent_send(pipe, record, payload, deadline):
    framed = struct.pack("!I", len(payload)) + payload
    offset = 0
    while offset < len(framed):
        left = _left(deadline)
        if _dead(record):
            raise RuntimeError("bounded HTTPS child stopped before request")
        try:
            count = os.write(pipe.fileno(), framed[offset:offset + READ_BYTES])
            if count <= 0:
                raise RuntimeError("private pipe closed")
            offset += count
        except BlockingIOError:
            wait([record.process.sentinel], timeout=min(0.01, left))
    _left(deadline)


def _parent_recv(pipe, record, maximum, deadline):
    # Connection.recv_bytes() can block on a partial frame even after poll().
    # Use nonblocking descriptor reads with an explicit bounded frame instead.
    def exact(count):
        result = bytearray()
        while len(result) < count:
            left = _left(deadline)
            ready = wait([pipe, record.process.sentinel], timeout=min(0.05, left))
            if pipe in ready:
                try:
                    data = os.read(pipe.fileno(), min(READ_BYTES, count - len(result)))
                except BlockingIOError:
                    continue
                if not data:
                    raise RuntimeError("private pipe closed")
                result.extend(data)
            elif record.process.sentinel in ready:
                raise RuntimeError("bounded HTTPS child stopped before result")
        _left(deadline)
        return bytes(result)
    size = struct.unpack("!I", exact(4))[0]
    if size > maximum:
        raise RuntimeError("private pipe bound exceeded")
    return exact(size)


class BufferedResponse:
    def __init__(self, endpoint, status, headers, body, deadline):
        self.final_url, self.status, self.headers = endpoint, status, headers
        self._body, self._offset, self._deadline, self._closed = body, 0, deadline, False

    def read(self, size, *, deadline, timeout):
        effective = min(self._deadline, deadline)
        _left(effective)
        if (self._closed or type(size) is not int or not 0 <= size <= READ_BYTES
                or type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0):
            raise RuntimeError("bounded HTTPS response read refused")
        result = self._body[self._offset:self._offset + size]
        self._offset += len(result)
        _left(effective)
        return result

    def close(self, *, deadline, timeout):
        self._closed, self._body = True, b""
        _left(min(self._deadline, deadline))
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout < 0:
            raise RuntimeError("bounded HTTPS response close refused")


class BoundedHTTPTransport:
    """Trusted host endpoint config only; max TWO owned children per parent.

    Parent enforces acceptance deadline with nonblocking pipe I/O and waits. It
    never returns bytes before its child is confirmed dead. Timeout triggers
    bounded own-child TERM/KILL joins (0.25s each); unconfirmed stop stays charged.
    No physical provider-stop proof or universal OS scheduler bound is claimed.
    """
    def __init__(self, endpoint):
        _endpoint(endpoint)
        if (os.name != "posix" or not (sys.platform == "darwin" or sys.platform.startswith("linux"))
                or sys.version_info < (3, 10) or getattr(sys, "frozen", False)):
            raise ValueError("bounded broker HTTPS requires unfrozen Python 3.10+ on macOS/Linux")
        self.endpoint = endpoint

    def open(self, request, *, deadline, timeout, max_response_bytes):
        _left(deadline)
        if (request.full_url != self.endpoint or request.get_method() != "POST"
                or type(request.data) is not bytes or len(request.data) > 32768
                or type(max_response_bytes) is not int or not 0 <= max_response_bytes <= MAX_BODY
                or type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0):
            raise RuntimeError("bounded broker HTTPS request refused")
        main_path = getattr(sys.modules.get("__main__"), "__file__", None)
        if not isinstance(main_path, str) or main_path.startswith("<"):
            raise RuntimeError("bounded broker HTTPS requires a trusted import-safe spawn entrypoint")
        headers = {key.casefold(): value for key, value in request.header_items()}
        packet = json.dumps({"endpoint": self.endpoint, "headers": headers,
            "body": base64.b64encode(request.data).decode("ascii"), "deadline": deadline,
            "maximum": max_response_bytes}, separators=(",", ":")).encode("utf-8")
        if len(packet) > MAX_REQUEST:
            raise RuntimeError("bounded broker HTTPS request bound exceeded")
        record = _reserve()
        parent_pipe = child_pipe = None
        try:
            context = multiprocessing.get_context("spawn")
            parent_pipe, child_pipe = context.Pipe(duplex=True)
            process = context.Process(target=_post_child, args=(child_pipe,), daemon=False)
            record.process = process
            record.start_attempted = True
            process.start()  # Args contain only the private Pipe, never headers.
            record.pid = process.pid
            child_pipe.close()
            child_pipe = None
            os.set_blocking(parent_pipe.fileno(), False)
            if _parent_recv(parent_pipe, record, 16, deadline) != b"ready":
                raise RuntimeError("bounded broker HTTPS child not ready")
            _parent_send(parent_pipe, record, packet, deadline)
            raw = _parent_recv(parent_pipe, record, MAX_PACKET, deadline)
            # Bytes from an alive/late child never become an accepted response.
            while not _dead(record):
                process.join(timeout=min(0.05, _left(deadline)))
            _left(deadline)
            if process.exitcode != 0:
                raise RuntimeError("bounded broker HTTPS child failed")
            result = json.loads(raw)
            if result.get("ok") is not True:
                raise RuntimeError("bounded broker HTTPS read refused")
            body = base64.b64decode(result["body"], validate=True)
            if (len(body) > max_response_bytes or type(result["status"]) is not int
                    or not 100 <= result["status"] <= 599 or not isinstance(result["headers"], dict)):
                raise RuntimeError("bounded broker HTTPS result refused")
            _left(deadline)
            return BufferedResponse(self.endpoint, result["status"], result["headers"], body, deadline)
        except BaseException:
            if not record.start_attempted:
                record.failed_before_start = True
            elif record.process is not None and record.pid is None:
                record.pid = record.process.pid
            _stop_owned(record)
            raise RuntimeError("bounded broker HTTPS failed or timed out; late result refused") from None
        finally:
            if parent_pipe is not None:
                parent_pipe.close()
            if child_pipe is not None:
                child_pipe.close()
            _release_dead(record)  # Unconfirmed liveness retains both record and slot.
            if record.confirmed_dead and record.process is not None:
                record.process.close()
