"""Independent verifier coverage for the capture-only daemon contract."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
import types
import unittest
from pathlib import Path

from hermes_weixin_transport.config import TransportConfig
from hermes_weixin_transport.daemon import InternalClient, run_capture_daemon
from hermes_weixin_transport.multi_user import MultiUserVault
from hermes_weixin_transport.transport import send_bound_once
import hermes_weixin_transport.daemon as daemon


class _Response:
    def __init__(self, payload: dict): self.payload = payload
    def __enter__(self): return self
    def __exit__(self, *_args): return False
    def read(self): return json.dumps(self.payload).encode()


class DaemonVerifierTests(unittest.TestCase):
    def test_bound_send_requires_exact_user_and_generation_without_exposing_peer(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state"; state.mkdir(mode=0o700)
            key = b"k" * 32; vault = MultiUserVault(state, key); vault.put(2, "private-peer", "private-token", 2)
            config = TransportConfig("account", "token", (), key); calls: list[object] = []
            async def post_once(_source, _config, request, context):
                calls.append((request.peer, context, request.idempotency_key))
                return {"ret": 0}
            stale = asyncio.run(send_bound_once(Path(directory), config, vault, 2, 1, "通知", "key-123", post_once=post_once))
            self.assertEqual(stale["status"], "permanent_failure")
            self.assertEqual(calls, [])
            sent = asyncio.run(send_bound_once(Path(directory), config, vault, 2, 2, "通知", "key-123", post_once=post_once))
            self.assertEqual(sent["status"], "sent")
            self.assertEqual(len(calls), 1)

    def test_internal_client_hmac_is_canonical_and_prepare_has_no_caller_user_id(self):
        original = daemon.urlopen
        seen: dict[str, object] = {}
        try:
            def fake_urlopen(request, timeout):
                raw = request.data
                body = json.loads(raw)
                seen["body"] = body
                timestamp = request.get_header("X-hermes-timestamp")
                nonce = request.get_header("X-hermes-nonce")
                signature = request.get_header("X-hermes-signature")
                canonical = "\n".join(("POST", "/internal/hermes-bindings/prepare", timestamp, nonce, hashlib.sha256(raw).hexdigest()))
                self.assertEqual(signature, hmac.new(b"s" * 32, canonical.encode(), hashlib.sha256).hexdigest())
                self.assertEqual(timeout, 10)
                return _Response({"code": 0, "data": {"userId": 2, "generation": 1, "activationId": "00000000-0000-4000-8000-000000000001"}})
            daemon.urlopen = fake_urlopen
            user, generation, activation = InternalClient("http://127.0.0.1:38116", "s" * 32).prepare("XYY-AAAAAAAAAAAAAAAAAAAAAAAAAA", "b" * 64)
            self.assertEqual((user, generation, activation), (2, 1, "00000000-0000-4000-8000-000000000001"))
            self.assertEqual(seen["body"], {"code": "XYY-AAAAAAAAAAAAAAAAAAAAAAAAAA", "peerFingerprint": "b" * 64})
        finally:
            daemon.urlopen = original

    def test_getupdates_item_list_binds_dm_and_rejects_group_without_reply_or_ai(self):
        modules = {key: sys.modules.get(key) for key in ("gateway", "gateway.platforms", "gateway.platforms.weixin")}
        calls: list[object] = []
        class Connector:
            async def close(self): calls.append("connector_closed")
        class Session:
            async def __aenter__(self): return self
            async def __aexit__(self, *_args): return False
        weixin = types.ModuleType("gateway.platforms.weixin")
        weixin.LONG_POLL_TIMEOUT_MS = 1000; weixin.ILINK_BASE_URL = "http://mock.invalid"; weixin.SESSION_EXPIRED_ERRCODE = 999
        weixin._make_ssl_connector = lambda: Connector()
        weixin.aiohttp = types.SimpleNamespace(ClientSession=lambda **_kwargs: Session())
        def chat_type(envelope, _account): return ("group", "") if envelope.get("room_id") else ("dm", "")
        weixin._guess_chat_type = chat_type
        def extract(items):
            calls.append(("extract", items))
            return items[0]["text_item"]["text"]
        weixin._extract_text = extract
        code = "XYY-AAAAAAAAAAAAAAAAAAAAAAAAAA"
        async def updates(_session, **kwargs):
            self.assertEqual(kwargs, {"base_url": weixin.ILINK_BASE_URL, "token": "token", "sync_buf": "", "timeout_ms": 1000})
            calls.append("getUpdates")
            return {"ret": 0, "errcode": 0, "msgs": [
                {"from_user_id": "group-peer", "to_user_id": "account", "room_id": "room-1", "context_token": "group-token", "item_list": [{"text_item": {"text": f"绑定 {code}"}}]},
                {"from_user_id": "dm-peer", "to_user_id": "account", "context_token": "dm-token", "item_list": [{"text_item": {"text": f"绑定 {code}"}}]},
            ], "get_updates_buf": "cursor-1"}
        weixin._get_updates = updates
        sys.modules["gateway"] = types.ModuleType("gateway"); sys.modules["gateway.platforms"] = types.ModuleType("gateway.platforms"); sys.modules["gateway.platforms.weixin"] = weixin
        testcase = self
        class Client:
            def prepare(self, received_code, _fp): testcase.assertEqual(received_code, code); calls.append("prepare"); return (2, 1, "00000000-0000-4000-8000-000000000001")
            def commit(self, user, generation, _fp, activation): testcase.assertEqual((user, generation, activation), (2, 1, "00000000-0000-4000-8000-000000000001")); calls.append("commit"); self.stop.set()
            def refresh(self, *_args): testcase.fail("unknown DM must bind, not refresh")
        try:
            with tempfile.TemporaryDirectory() as directory:
                state = Path(directory) / "state"; state.mkdir(mode=0o700)
                key = b"k" * 32; config = TransportConfig("account", "token", (), key); vault = MultiUserVault(state, key); stop = asyncio.Event()
                client = Client(); client.stop = stop
                asyncio.run(run_capture_daemon(Path(directory), config, vault, client, stop, poll_interval=0.001))
                self.assertEqual(vault.get(2, 1)["peer"], "dm-peer")
                self.assertEqual(vault.get(2, 1)["token"], "dm-token")
                self.assertEqual(vault.user_for_peer("group-peer"), None)
                self.assertEqual(calls.count("prepare"), 1); self.assertEqual(calls.count("commit"), 1)
                self.assertEqual(len([call for call in calls if isinstance(call, tuple) and call[0] == "extract"]), 1)
        finally:
            for key, value in modules.items():
                if value is None: sys.modules.pop(key, None)
                else: sys.modules[key] = value

    def test_vault_flock_capacity_and_peer_conflict_are_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state"; state.mkdir(mode=0o700)
            vault = MultiUserVault(state, b"k" * 32)
            def put(user: int) -> str:
                try:
                    vault.put(user, f"peer-{user}", f"token-{user}", 1)
                    return "ok"
                except ValueError:
                    return "blocked"
            with ThreadPoolExecutor(max_workers=11) as executor:
                result = list(executor.map(put, range(1, 12)))
            self.assertEqual(result.count("ok"), 10)
            self.assertEqual(result.count("blocked"), 1)
            with self.assertRaisesRegex(ValueError, "peer conflict"):
                vault.put(12, "peer-1", "other-token", 1)

    def test_restart_recovers_prepared_binding_before_poll(self):
        modules = {key: sys.modules.get(key) for key in ("gateway", "gateway.platforms", "gateway.platforms.weixin")}
        calls: list[object] = []
        class Connector:
            async def close(self): return None
        class Session:
            async def __aenter__(self): return self
            async def __aexit__(self, *_args): return False
        weixin = types.ModuleType("gateway.platforms.weixin")
        weixin.LONG_POLL_TIMEOUT_MS = 1000; weixin.ILINK_BASE_URL = "http://mock.invalid"; weixin.SESSION_EXPIRED_ERRCODE = 999
        weixin._make_ssl_connector = lambda: Connector(); weixin.aiohttp = types.SimpleNamespace(ClientSession=lambda **_kwargs: Session())
        weixin._guess_chat_type = lambda *_args: ("dm", "")
        weixin._extract_text = lambda *_args: ""
        async def updates(_session, **kwargs):
            calls.append(("poll", kwargs)); return {"ret": 0, "errcode": 0, "msgs": []}
        weixin._get_updates = updates
        sys.modules["gateway"] = types.ModuleType("gateway"); sys.modules["gateway.platforms"] = types.ModuleType("gateway.platforms"); sys.modules["gateway.platforms.weixin"] = weixin
        testcase = self
        class Client:
            def commit(self, user, generation, fingerprint, activation):
                calls.append(("commit", user, generation, fingerprint, activation)); self.stop.set()
            def refresh(self, *_args): testcase.fail("recovery must not refresh")
        try:
            with tempfile.TemporaryDirectory() as directory:
                state = Path(directory) / "state"; state.mkdir(mode=0o700)
                vault = MultiUserVault(state, b"k" * 32)
                activation = "00000000-0000-4000-8000-000000000001"
                vault.put(2, "peer", "token", 3, prepared=True, activation_id=activation)
                client = Client(); client.stop = asyncio.Event()
                asyncio.run(run_capture_daemon(Path(directory), TransportConfig("account", "token", (), b"k" * 32), vault, client, client.stop, poll_interval=0.001))
                self.assertEqual(vault.get(2, 3)["peer"], "peer")
                self.assertEqual(calls[0][:3], ("commit", 2, 3))
        finally:
            for key, value in modules.items():
                if value is None: sys.modules.pop(key, None)
                else: sys.modules[key] = value


if __name__ == "__main__":
    unittest.main()
