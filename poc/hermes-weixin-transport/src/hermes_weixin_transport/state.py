"""Minimal encrypted token state for one configured Hermes Weixin account."""

from __future__ import annotations

import base64
import fcntl
import hashlib
import hmac
import json
import os
import secrets
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .config import TransportConfig
from .security import SecurityError, ensure_state_directory, normalized_external_path, open_private_lock, require_private_file, require_state_directory


class StateError(RuntimeError):
    pass


_LOCAL_LOCKS_GUARD = threading.Lock()
_LOCAL_LOCKS: dict[str, threading.RLock] = {}


def _local_lock(path: Path) -> threading.RLock:
    key = os.fspath(path)
    with _LOCAL_LOCKS_GUARD:
        return _LOCAL_LOCKS.setdefault(key, threading.RLock())


def _canon(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _derive(root: bytes, label: bytes) -> bytes:
    return hmac.new(root, b"xiansuo/hermes-weixin-state/v2/" + label, hashlib.sha256).digest()


def _entry_ref(config: TransportConfig, peer: str) -> str:
    key = _derive(config.hmac_key, b"index")
    return hmac.new(key, f"{config.account_id}\0{peer}".encode("utf-8"), hashlib.sha256).hexdigest()


def _stream(key: bytes, nonce: bytes, length: int) -> bytes:
    blocks: list[bytes] = []
    for counter in range((length + 31) // 32):
        blocks.append(hmac.new(key, nonce + counter.to_bytes(8, "big"), hashlib.sha256).digest())
    return b"".join(blocks)[:length]


def _xor(left: bytes, right: bytes) -> bytes:
    return bytes(a ^ b for a, b in zip(left, right))


def _entry_tag(config: TransportConfig, reference: str, nonce: str, ciphertext: str) -> str:
    key = _derive(config.hmac_key, b"entry-mac")
    return hmac.new(key, _canon({"ref": reference, "nonce": nonce, "ciphertext": ciphertext}), hashlib.sha256).hexdigest()


def _entries_mac(config: TransportConfig, entries: object) -> str:
    key = _derive(config.hmac_key, b"entries-mac")
    return hmac.new(key, _canon(entries), hashlib.sha256).hexdigest()


def _encrypt_token(config: TransportConfig, reference: str, token: str) -> dict[str, str]:
    plaintext = token.encode("utf-8")
    nonce_bytes = secrets.token_bytes(32)
    ciphertext_bytes = _xor(plaintext, _stream(_derive(config.hmac_key, b"encrypt"), nonce_bytes, len(plaintext)))
    nonce = base64.b64encode(nonce_bytes).decode("ascii")
    ciphertext = base64.b64encode(ciphertext_bytes).decode("ascii")
    return {"nonce": nonce, "ciphertext": ciphertext, "tag": _entry_tag(config, reference, nonce, ciphertext)}


def _decrypt_token(config: TransportConfig, reference: str, entry: object) -> str:
    if not isinstance(entry, dict) or set(entry) != {"nonce", "ciphertext", "tag"}:
        raise ValueError("entry")
    nonce, ciphertext, tag = entry.get("nonce"), entry.get("ciphertext"), entry.get("tag")
    if not isinstance(nonce, str) or not isinstance(ciphertext, str) or not isinstance(tag, str):
        raise ValueError("entry")
    if not hmac.compare_digest(tag, _entry_tag(config, reference, nonce, ciphertext)):
        raise ValueError("tag")
    try:
        nonce_bytes = base64.b64decode(nonce, validate=True)
        ciphertext_bytes = base64.b64decode(ciphertext, validate=True)
    except Exception as exc:
        raise ValueError("base64") from exc
    if len(nonce_bytes) != 32 or not ciphertext_bytes or len(ciphertext_bytes) > 8192:
        raise ValueError("length")
    try:
        token = _xor(ciphertext_bytes, _stream(_derive(config.hmac_key, b"encrypt"), nonce_bytes, len(ciphertext_bytes))).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("encoding") from exc
    if not token:
        raise ValueError("token")
    return token


class TokenState:
    def __init__(self, directory: str | Path, config: TransportConfig):
        try:
            self.directory = normalized_external_path(Path(directory), kind="状态目录", allow_missing_final=True)
        except SecurityError as exc:
            raise StateError("状态目录不安全") from exc
        self.config = config
        self.tokens_path = self.directory / "context-tokens.json"
        self.lock_path = self.directory / "context-tokens.lock"

    def _ensure(self, *, create: bool) -> None:
        try:
            if create:
                ensure_state_directory(self.directory)
            else:
                require_state_directory(self.directory)
            if os.path.lexists(self.tokens_path):
                require_private_file(self.tokens_path, kind="token 状态文件")
        except SecurityError as exc:
            raise StateError("状态目录或文件不安全") from exc

    @contextmanager
    def _locked(self, *, create: bool) -> Iterator[None]:
        self._ensure(create=create)
        local = _local_lock(self.lock_path)
        with local:
            try:
                fd = open_private_lock(self.lock_path)
                with os.fdopen(fd, "r+b", buffering=0) as lock_file:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
                    try:
                        yield
                    finally:
                        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            except (OSError, SecurityError) as exc:
                raise StateError("无法锁定 token 状态") from exc

    def _empty(self) -> dict[str, object]:
        return {"schema": 2, "entries": {}, "entries_mac": _entries_mac(self.config, {})}

    def _migrate_v1_unlocked(self, raw: dict[str, object]) -> dict[str, object]:
        """Remove pre-overlay raw values atomically while preserving usable tokens."""
        if raw.get("account_id") != self.config.account_id or not isinstance(raw.get("tokens"), dict) or not isinstance(raw.get("refs_mac"), str):
            raise ValueError("v1")
        tokens = raw["tokens"]
        if not hmac.compare_digest(raw["refs_mac"], hmac.new(self.config.hmac_key, _canon(tokens), hashlib.sha256).hexdigest()):
            raise ValueError("v1mac")
        migrated = self._empty(); entries = migrated["entries"]
        assert isinstance(entries, dict)
        for peer, item in tokens.items():
            if not isinstance(peer, str) or not isinstance(item, dict):
                raise ValueError("v1entry")
            token, reference = item.get("token"), item.get("ref")
            if not isinstance(token, str) or not token or not isinstance(reference, str):
                raise ValueError("v1token")
            expected = hmac.new(self.config.hmac_key, f"{self.config.account_id}\0{peer}\0{token}".encode("utf-8"), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(reference, expected):
                raise ValueError("v1ref")
            index = _entry_ref(self.config, peer)
            entries[index] = _encrypt_token(self.config, index, token)
        self._write_unlocked(migrated)
        return migrated

    def _load_unlocked(self) -> dict[str, object]:
        if not os.path.lexists(self.tokens_path):
            return self._empty()
        try:
            require_private_file(self.tokens_path, kind="token 状态文件")
            raw = json.loads(self.tokens_path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                raise ValueError("shape")
            if raw.get("schema") == 1:
                return self._migrate_v1_unlocked(raw)
            if raw.get("schema") != 2 or set(raw) != {"schema", "entries", "entries_mac"}:
                raise ValueError("schema")
            entries, entries_mac = raw.get("entries"), raw.get("entries_mac")
            if not isinstance(entries, dict) or not isinstance(entries_mac, str):
                raise ValueError("shape")
            if not hmac.compare_digest(entries_mac, _entries_mac(self.config, entries)):
                raise ValueError("mac")
            for reference, entry in entries.items():
                if not isinstance(reference, str) or not re_full_hex(reference):
                    raise ValueError("reference")
                _decrypt_token(self.config, reference, entry)
            return raw
        except (OSError, SecurityError, ValueError, json.JSONDecodeError) as exc:
            raise StateError("context token 状态无效或已被篡改") from exc

    def _write_unlocked(self, raw: dict[str, object]) -> None:
        entries = raw["entries"]
        assert isinstance(entries, dict)
        raw["entries_mac"] = _entries_mac(self.config, entries)
        fd, temp_name = tempfile.mkstemp(prefix=".context-tokens.", dir=self.directory)
        temp_path = Path(temp_name)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as out:
                out.write(_canon(raw))
                out.flush()
                os.fsync(out.fileno())
            require_private_file(temp_path, kind="临时 token 状态文件")
            os.replace(temp_path, self.tokens_path)
            require_private_file(self.tokens_path, kind="token 状态文件")
            directory_fd = os.open(self.directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except (OSError, SecurityError) as exc:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise StateError("无法原子保存 context token") from exc

    def capture(self, peer: str, token: str) -> None:
        """Persist the latest allowed token without persisting raw identifiers."""
        with self._locked(create=True):
            raw = self._load_unlocked(); entries = raw["entries"]
            assert isinstance(entries, dict)
            reference = _entry_ref(self.config, peer)
            entries[reference] = _encrypt_token(self.config, reference, token)
            self._write_unlocked(raw)

    def token_for(self, peer: str) -> str | None:
        if not os.path.lexists(self.directory):
            return None
        with self._locked(create=False):
            raw = self._load_unlocked(); entries = raw["entries"]
            assert isinstance(entries, dict)
            reference = _entry_ref(self.config, peer)
            entry = entries.get(reference)
            return _decrypt_token(self.config, reference, entry) if entry is not None else None


def re_full_hex(value: str) -> bool:
    return len(value) == 64 and all(char in "0123456789abcdef" for char in value)
