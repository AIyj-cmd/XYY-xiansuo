"""Capture-only multi-user binding primitives.

This module has no Agent, model, reply, typing or media dependency.  A daemon
injects a poll function and passes every inbound envelope through
``capture_inbound``; only an exact binding command or a known bound peer can
change the external encrypted vault.
"""
from __future__ import annotations

import base64
import fcntl
import hashlib
import hmac
import json
import os
import re
import tempfile
from pathlib import Path
from contextlib import contextmanager
from typing import Any, Callable

from .security import ensure_state_directory, require_private_file

_COMMAND = re.compile(r"^绑定 (XYY-[A-Z2-7]{26})$")


def peer_fingerprint(peer: str, key: bytes) -> str:
    return hmac.new(key, b"xiansuo/hermes/peer/v1\0" + peer.encode(), hashlib.sha256).hexdigest()


class MultiUserVault:
    """Authenticated encrypted vault outside the repository (0700/0600)."""
    def __init__(self, directory: str | Path, key: bytes):
        if len(key) < 32:
            raise ValueError("vault key too short")
        self.directory, self.key = Path(directory), key
        self.path = self.directory / "bindings.json"
        self.lock_path = self.directory / "bindings.lock"

    @contextmanager
    def _locked(self):
        ensure_state_directory(self.directory)
        fd = os.open(self.lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            os.fchmod(fd, 0o600); fcntl.flock(fd, fcntl.LOCK_EX); yield
        finally:
            try: fcntl.flock(fd, fcntl.LOCK_UN)
            finally: os.close(fd)

    def _crypt(self, nonce: bytes, value: bytes) -> bytes:
        stream = b""; counter = 0
        while len(stream) < len(value):
            stream += hmac.new(self.key, b"stream\0" + nonce + counter.to_bytes(8, "big"), hashlib.sha256).digest(); counter += 1
        return bytes(a ^ b for a, b in zip(value, stream))

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"schema": 1, "entries": {}}
        require_private_file(self.path, kind="多人绑定 vault")
        raw = json.loads(self.path.read_text())
        if not isinstance(raw, dict) or raw.get("schema") != 1 or not isinstance(raw.get("entries"), dict):
            raise ValueError("vault invalid")
        return raw

    def _save(self, raw: dict[str, Any]) -> None:
        ensure_state_directory(self.directory)
        fd, name = tempfile.mkstemp(prefix=".bindings.", dir=self.directory)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as out:
                json.dump(raw, out, sort_keys=True, separators=(",", ":")); out.flush(); os.fsync(out.fileno())
            os.replace(name, self.path); require_private_file(self.path, kind="多人绑定 vault")
        finally:
            try: os.unlink(name)
            except FileNotFoundError: pass

    def put(self, user_id: int, peer: str, context_token: str, generation: int, cursor: str | None = None, *, prepared: bool = False, activation_id: str | None = None) -> None:
        if user_id < 1 or generation < 1 or not peer or not context_token:
            raise ValueError("entry invalid")
        with self._locked():
            self._put_unlocked(user_id, peer, context_token, generation, cursor, prepared=prepared, activation_id=activation_id)

    def _put_unlocked(self, user_id: int, peer: str, context_token: str, generation: int, cursor: str | None, *, prepared: bool, activation_id: str | None) -> None:
        """Write one entry while the caller holds ``bindings.lock``."""
        raw = self._load()
        non_cursor = [key for key in raw["entries"] if key != "0"]
        for key in non_cursor:
            old = self._entry(int(key))
            if old and old.get("peer") == peer and int(key) != user_id:
                raise ValueError("peer conflict")
        if str(user_id) not in raw["entries"] and len(non_cursor) >= 10:
            raise ValueError("vault capacity")
        if prepared and not activation_id:
            raise ValueError("activation id required")
        nonce = os.urandom(32)
        plain = json.dumps({"peer": peer, "token": context_token, "generation": generation, "cursor": cursor, "state": "prepared" if prepared else "active", "activationId": activation_id}, separators=(",", ":")).encode()
        cipher = base64.b64encode(self._crypt(nonce, plain)).decode(); nonce64 = base64.b64encode(nonce).decode()
        tag = hmac.new(self.key, f"{user_id}\0{nonce64}\0{cipher}".encode(), hashlib.sha256).hexdigest()
        raw["entries"][str(user_id)] = {"nonce": nonce64, "ciphertext": cipher, "tag": tag}
        self._save(raw)

    def cursor(self) -> str:
        with self._locked():
            data = self._entry(0)
            return data.get("cursor", "") if isinstance(data, dict) and isinstance(data.get("cursor", ""), str) else ""

    def set_cursor(self, cursor: str) -> None:
        if not cursor or len(cursor) > 8192: raise ValueError("cursor invalid")
        with self._locked():
            raw = self._load(); nonce = os.urandom(32); plain = json.dumps({"cursor": cursor}, separators=(",", ":")).encode(); cipher = base64.b64encode(self._crypt(nonce, plain)).decode(); nonce64 = base64.b64encode(nonce).decode(); tag = hmac.new(self.key, f"0\0{nonce64}\0{cipher}".encode(), hashlib.sha256).hexdigest(); raw["entries"]["0"] = {"nonce": nonce64, "ciphertext": cipher, "tag": tag}; self._save(raw)

    def _entry(self, user_id: int) -> dict[str, Any] | None:
        entry = self._load()["entries"].get(str(user_id))
        if not isinstance(entry, dict): return None
        nonce, cipher, tag = entry.get("nonce"), entry.get("ciphertext"), entry.get("tag")
        if not all(isinstance(x, str) for x in (nonce, cipher, tag)) or not hmac.compare_digest(tag, hmac.new(self.key, f"{user_id}\0{nonce}\0{cipher}".encode(), hashlib.sha256).hexdigest()): raise ValueError("vault tampered")
        data = json.loads(self._crypt(base64.b64decode(nonce), base64.b64decode(cipher)).decode())
        return data

    def get(self, user_id: int, generation: int) -> dict[str, Any] | None:
        with self._locked():
            data = self._entry(user_id)
            return data if data is not None and data.get("generation") == generation and data.get("state") == "active" else None

    def activate(self, user_id: int, generation: int, activation_id: str) -> None:
        with self._locked():
            data = self._entry(user_id)
            if not data or data.get("generation") != generation or data.get("state") != "prepared" or data.get("activationId") != activation_id:
                raise ValueError("prepared binding missing")
            self._put_unlocked(user_id, str(data["peer"]), str(data["token"]), generation, data.get("cursor"), prepared=False, activation_id=None)

    def user_for_peer(self, peer: str) -> int | None:
        with self._locked(): return self._user_for_peer(peer)

    def _user_for_peer(self, peer: str) -> int | None:
        for raw_user in self._load()["entries"]:
            if raw_user == "0": continue
            data = self._entry(int(raw_user))
            if isinstance(data, dict) and data.get("peer") == peer and isinstance(data.get("generation"), int): return int(raw_user)
        return None

    def binding_for_peer(self, peer: str) -> tuple[int, dict[str, Any]] | None:
        """Return an active binding for a peer while holding the vault lock."""
        with self._locked():
            user_id = self._user_for_peer(peer)
            if user_id is None:
                return None
            data = self._entry(user_id)
            return (user_id, data) if data and data.get("state") == "active" else None

    def prepared_entries(self) -> list[tuple[int, dict[str, Any]]]:
        """Snapshot encrypted prepared records for crash recovery; never exposes codes."""
        with self._locked():
            result: list[tuple[int, dict[str, Any]]] = []
            for raw_user in self._load()["entries"]:
                if raw_user == "0":
                    continue
                data = self._entry(int(raw_user))
                if data and data.get("state") == "prepared":
                    result.append((int(raw_user), data))
            return result


def capture_inbound(inbound: object, account_id: str, vault: MultiUserVault, prepare: Callable[[str], tuple[int, int, str]], commit: Callable[[int, int, str, str], None], refresh: Callable[[int, int, str], None]) -> str:
    """Handle one DM.  Return only fixed status strings; never reply upstream."""
    if not isinstance(inbound, dict) or inbound.get("to_user_id") != account_id or inbound.get("room_id") or inbound.get("chat_room_id"):
        return "ignored"
    peer, token = inbound.get("from_user_id"), inbound.get("context_token")
    if not isinstance(peer, str) or peer == account_id or not isinstance(token, str) or not token:
        return "ignored"
    text = inbound.get("text")
    command = _COMMAND.fullmatch(text) if isinstance(text, str) else None
    fp = peer_fingerprint(peer, vault.key)
    if command:
        user_id, generation, activation_id = prepare(command.group(1))
        vault.put(user_id, peer, token, generation, inbound.get("cursor") if isinstance(inbound.get("cursor"), str) else None, prepared=True, activation_id=activation_id)
        commit(user_id, generation, fp, activation_id)
        return "bound"
    # Refresh is attempted only for a local known binding; callers reject a
    # mismatched fingerprint/generation server-side. No arbitrary inbound text
    # is retained or interpreted.
    bound = vault.binding_for_peer(peer)
    if bound:
        user_id, entry_data = bound
        refresh(user_id, int(entry_data["generation"]), fp)
        vault.put(user_id, peer, token, int(entry_data["generation"]), entry_data.get("cursor"))
        return "refreshed"
    return "ignored"
