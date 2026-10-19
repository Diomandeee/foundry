"""Conservative source-only selection/screening; never log matched values."""
import re
import unicodedata
from common import safe_path

MAX_SOURCE_BYTES = 4 * 1024**2
MAX_ADDED_FILES = 1024
PROTECTED = {".git", ".hg", ".svn", ".codex", ".claude", ".ao", ".history",
             "memory", "memory.md", "session_state.md", "prompt-logs", "file-history",
             ".foundry-workspace.json", ".ssh", ".aws", ".azure", ".kube", ".docker",
             "gcloud", "gh", ".gnupg", ".netrc", ".npmrc", ".pypirc", ".git-credentials", ".gitconfig",
             "auth.json", "oauth.json", "oauth2.json", "service-account.json", "service_account.json", "kubeconfig",
             "authorized_keys", "known_hosts", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"}
SENSITIVE_NAME = re.compile(r"(?:^|[._-])(?:credentials?|secrets?|tokens?|passwords?|passwd|private[_-]?keys?|keychain|keystore|firebase-adminsdk)(?:$|[._-])")
SENSITIVE_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".keychain", ".keychain-db")
KEY = r"(?:private[_-]?key|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|token|authorization|aws_access_key_id|aws_secret_access_key)"
CONTENT_DENY = [re.compile(pattern, re.IGNORECASE) for pattern in (
    r"-----BEGIN[^\r\n]{0,80}PRIVATE KEY-----",
    r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
    r"\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|npm_[a-z0-9]{20,})\b",
    r"\bAIza[a-z0-9_-]{20,}\b",
    r"\bxox[baprs]-[a-z0-9-]{10,}\b",
    r"\b(?:sk|rk)_(?:live|test)_[a-z0-9]{12,}\b",
    r"\b(?:bearer|basic)[ \t]+[a-z0-9+/=_~.-]{8,}",
    r"\beyJ[a-z0-9_-]{6,}\.[a-z0-9_-]+\.[a-z0-9_-]+\b",
    r"\b[a-z][a-z0-9+.-]{0,20}://[^/\s:@]{1,128}:[^/\s@]{1,256}@",
    r"[\"']?" + KEY + r"[\"']?\s*[:=]\s*(?:[rubf]{0,2})[\"'][^\"'\r\n]+[\"']",
    r"(?m)^\s*(?:export\s+)?" + KEY + r"\s*=\s*[a-z0-9+/=_.~-]{6,}\s*(?:#.*)?$",
)]


def source_path(value):
    name = safe_path(value)
    if len(name.encode("utf-8")) > 4096 or len(name.split("/")) > 64 or any(c in name for c in "*?[]"):
        raise ValueError("snapshot requires bounded explicit file paths, without glob syntax")
    for part in name.split("/"):
        folded = unicodedata.normalize("NFKC", part).casefold()
        if (folded in PROTECTED or folded.startswith(".env") or folded.endswith(SENSITIVE_SUFFIXES)
                or SENSITIVE_NAME.search(folded) or folded.rstrip(" .") != folded):
            raise ValueError("snapshot refuses protected history or credential-shaped paths")
    return name


def selection(base_entries, include_new):
    if include_new is None:
        include_new = []
    if not isinstance(include_new, (list, tuple)) or len(include_new) > MAX_ADDED_FILES:
        raise ValueError("snapshot added-file allowlist exceeds bound or has invalid type")
    base = {source_path(entry["path"]) for entry in base_entries}
    added = [source_path(path) for path in include_new]
    if len(set(added)) != len(added) or base.intersection(added):
        raise ValueError("snapshot include-new must name distinct files absent from the selected base")
    files, seen = base.union(added), {}
    for name in files:
        parts = name.split("/")
        for n in range(1, len(parts) + 1):
            prefix = "/".join(parts[:n])
            key = unicodedata.normalize("NFD", prefix).casefold()
            if key in seen and seen[key] != prefix:
                raise ValueError("snapshot selected paths have a case/Unicode collision")
            seen[key] = prefix
        if any("/".join(parts[:n]) in files for n in range(1, len(parts))):
            raise ValueError("snapshot selected paths have a file/directory collision")
    return base, set(added)


def screen_source(raw):
    # Buffer one bounded candidate, then screen the WHOLE text before any write.
    # This avoids boundary-split matches or persisting an earlier secret prefix.
    if len(raw) > MAX_SOURCE_BYTES:
        raise ValueError("snapshot source text size bound exceeded")
    try:
        text = raw.decode("utf-8")
    except UnicodeError:
        raise ValueError("snapshot refuses binary or non-UTF-8 source content") from None
    if any((ord(c) < 32 and c not in "\n\r\t") or ord(c) == 127 for c in text):
        raise ValueError("snapshot refuses binary/control source content")
    if any(pattern.search(text) for pattern in CONTENT_DENY):
        raise ValueError("snapshot source content refused by credential screening")
    # Conservative long opaque credential-like literals; ordinary hex digests
    # are excluded. False positives are held, never bypassed with a CLI switch.
    for match in re.finditer(r"[\"']([a-zA-Z0-9+/=_-]{40,})[\"']", text):
        value = match.group(1)
        if (not re.fullmatch(r"[0-9a-fA-F]+", value) and re.search(r"[a-z]", value)
                and re.search(r"[A-Z]", value) and re.search(r"[0-9]", value)):
            raise ValueError("snapshot source content refused by credential screening")
