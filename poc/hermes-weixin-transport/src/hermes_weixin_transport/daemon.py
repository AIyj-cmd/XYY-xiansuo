"""Runnable, deliberately narrow Hermes capture-only long-poll daemon."""
from __future__ import annotations
import asyncio, hashlib, hmac, json, os, secrets, time
from pathlib import Path
from urllib.request import Request, urlopen
from typing import Any
from .config import TransportConfig
from .multi_user import MultiUserVault, capture_inbound, peer_fingerprint
from .upstream_gate import VerifiedUpstream, load_verified_weixin

class InternalClient:
    def __init__(self, base_url: str, secret: str): self.base_url, self.secret = base_url.rstrip("/"), secret
    def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        raw = json.dumps(body, separators=(",", ":")).encode(); ts = str(int(time.time()*1000)); nonce = secrets.token_urlsafe(24)
        canonical = "\n".join(("POST", path, ts, nonce, hashlib.sha256(raw).hexdigest()))
        headers = {"content-type":"application/json", "x-hermes-timestamp":ts, "x-hermes-nonce":nonce, "x-hermes-signature":hmac.new(self.secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()}
        with urlopen(Request(self.base_url + path, raw, headers), timeout=10) as response: # nosec: configured loopback operator endpoint
            value = json.loads(response.read())
        if not isinstance(value, dict) or value.get("code") != 0 or not isinstance(value.get("data"), dict): raise RuntimeError("internal rejected")
        return value["data"]
    def prepare(self, code: str, fp: str) -> tuple[int,int,str]:
        result = self.post("/internal/hermes-bindings/prepare", {"code": code, "peerFingerprint": fp})
        # Server identifies the user by code; it returns userId only to this authenticated daemon.
        return int(result["userId"]), int(result["generation"]), str(result["activationId"])
    def commit(self, user: int, generation: int, fp: str, activation_id: str) -> None: self.post("/internal/hermes-bindings/commit", {"userId":user,"activationId":activation_id,"peerFingerprint":fp,"generation":generation})
    def refresh(self, user: int, generation: int, fp: str) -> None: self.post("/internal/hermes-bindings/refresh", {"userId":user,"peerFingerprint":fp,"generation":generation})

async def run_capture_daemon(source_root: VerifiedUpstream, config: TransportConfig, vault: MultiUserVault, client: InternalClient, stop: asyncio.Event, poll_interval: float = 0.1) -> None:
    """Long poll only. No agent lifecycle, response, typing, media or AI path exists."""
    weixin = load_verified_weixin(source_root)
    cursor = vault.cursor()
    timeout_ms = int(getattr(weixin, "LONG_POLL_TIMEOUT_MS", 35_000))
    failures = 0
    connector = weixin._make_ssl_connector()
    try:
        async with weixin.aiohttp.ClientSession(connector=connector, trust_env=False) as session:
            while not stop.is_set():
                try:
                    # A process crash can happen after server commit but before
                    # vault activation. Replaying commit is explicitly idempotent.
                    for user_id, entry in vault.prepared_entries():
                        generation = int(entry["generation"])
                        activation_id = str(entry["activationId"])
                        client.commit(user_id, generation, peer_fingerprint(str(entry["peer"]), vault.key), activation_id)
                        vault.activate(user_id, generation, activation_id)
                    response = await weixin._get_updates(session, base_url=weixin.ILINK_BASE_URL, token=config.ilink_token, sync_buf=cursor, timeout_ms=timeout_ms)
                    suggested = response.get("longpolling_timeout_ms") if isinstance(response, dict) else None
                    if isinstance(suggested, int) and 1_000 <= suggested <= 60_000: timeout_ms = suggested
                    ret = response.get("ret", 0) if isinstance(response, dict) else None; errcode = response.get("errcode", 0) if isinstance(response, dict) else None
                    if not ((ret in (0, None)) and (errcode in (0, None))):
                        if ret == weixin.SESSION_EXPIRED_ERRCODE or errcode == weixin.SESSION_EXPIRED_ERRCODE: raise RuntimeError("session expired")
                        raise RuntimeError("getupdates rejected")
                    failures = 0
                    messages = response.get("msgs", []) if isinstance(response, dict) else []
                    for envelope in messages if isinstance(messages, list) else []:
                        inbound = envelope if isinstance(envelope, dict) else {}
                        chat_type, _ = weixin._guess_chat_type(inbound, config.account_id)
                        if chat_type == "group": continue
                        peer = inbound.get("from_user_id")
                        # Only an unknown peer's exact command needs text.
                        if isinstance(peer, str) and vault.user_for_peer(peer) is None:
                            item_list = inbound.get("item_list")
                            inbound = {**inbound, "text": weixin._extract_text(item_list if isinstance(item_list, list) else [])}
                        # exact binding command is the sole reason an unknown peer's text is inspected
                        code_holder: dict[str,str] = {}
                        def prepare(code: str) -> tuple[int,int,str]:
                            code_holder["code"] = code; fp = peer_fingerprint(str(inbound.get("from_user_id", "")), vault.key)
                            return client.prepare(code, fp)
                        def commit(user: int, gen: int, fp: str, activation_id: str) -> None:
                            client.commit(user, gen, fp, activation_id)
                            vault.activate(user, gen, activation_id)
                        capture_inbound(inbound, config.account_id, vault, prepare, commit, client.refresh)
                    next_cursor = response.get("get_updates_buf") if isinstance(response, dict) else None
                    if isinstance(next_cursor, str) and next_cursor != cursor: cursor = next_cursor; vault.set_cursor(cursor)
                except asyncio.CancelledError: raise
                except Exception:
                    failures += 1
                    await asyncio.sleep(min(30.0, max(poll_interval, 0.25 * (2 ** min(failures, 6)))))
    finally:
        if connector is not None: await connector.close()
