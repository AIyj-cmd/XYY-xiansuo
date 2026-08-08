#!/usr/bin/env python3
"""Hermes Weixin v2026.8.3 离线、无网络 PoC。

This file intentionally tests the upstream source in HERMES_OFFLINE_POC_SOURCE
instead of copying or modifying it.  Every state directory is randomized under
/tmp and socket DNS/connect APIs are fail-closed while the test body runs.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch


EXPECTED_COMMIT = "3c27eb6234bf91b8ceee9e9071591b31e9b148cb"
SOURCE_ROOT = Path(
    os.environ.get("HERMES_OFFLINE_POC_SOURCE", "/tmp/hermes-agent-v2026.8.3")
).resolve()
_TEMP_ROOT = Path(tempfile.mkdtemp(prefix="xiansuo-hermes-weixin-offline-"))
_TEMP_HOME = _TEMP_ROOT / "hermes-home"
_TEMP_OS_HOME = _TEMP_ROOT / "os-home"

# Set before importing Hermes so no default ~/.hermes state can be consulted.
os.environ["HERMES_HOME"] = str(_TEMP_HOME)
os.environ["HOME"] = str(_TEMP_OS_HOME)
os.environ["XDG_CONFIG_HOME"] = str(_TEMP_OS_HOME / "config")
os.environ["XDG_DATA_HOME"] = str(_TEMP_OS_HOME / "data")
sys.path.insert(0, str(SOURCE_ROOT))

from gateway.config import Platform, PlatformConfig  # noqa: E402
from gateway.platforms import weixin  # noqa: E402
from gateway.platforms.base import MessageEvent  # noqa: E402
from gateway.platforms.weixin import ContextTokenStore, WeixinAdapter  # noqa: E402
from gateway.run import GatewayRunner  # noqa: E402
from hermes_cli import send_cmd as hermes_send_cmd  # noqa: E402
import tools.send_message_tool as send_message_tool_module  # noqa: E402


class NetworkForbidden:
    """Block DNS and socket network entry points, recording any attempted use."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self._patches: list[patch] = []

    def _deny(self, name: str):
        def denied(*_args, **_kwargs):
            self.calls.append(name)
            raise AssertionError(f"离线 PoC 禁止网络操作：{name}")

        return denied

    def __enter__(self):
        for target, replacement in (
            ("socket.getaddrinfo", self._deny("socket.getaddrinfo")),
            ("socket.gethostbyname", self._deny("socket.gethostbyname")),
            ("socket.create_connection", self._deny("socket.create_connection")),
            ("socket.socket.connect", self._deny("socket.socket.connect")),
            ("socket.socket.connect_ex", self._deny("socket.socket.connect_ex")),
            ("socket.socket.sendto", self._deny("socket.socket.sendto")),
        ):
            item = patch(target, replacement)
            item.start()
            self._patches.append(item)
        return self

    def __exit__(self, *_exc):
        for item in reversed(self._patches):
            item.stop()
        self._patches.clear()


@contextlib.contextmanager
def offline_network():
    guard = NetworkForbidden()
    with guard:
        yield guard
    if guard.calls:
        raise AssertionError(f"检测到网络尝试：{guard.calls}")


def make_adapter(*, policy: str, allowed: list[str] | None = None) -> WeixinAdapter:
    return WeixinAdapter(
        PlatformConfig(
            enabled=True,
            token="offline-token",
            extra={
                "account_id": "offline-account",
                "base_url": "https://ilink.invalid",
                "dm_policy": policy,
                "allow_from": allowed or [],
                "text_batch_delay_seconds": 0,
                "text_batch_split_delay_seconds": 0,
                # Hermes reads this option with ``or``; use the string form so
                # it remains truthy at lookup then parses to a zero-second wait.
                "send_chunk_retry_delay_seconds": "0",
            },
        )
    )


def inbound(peer: str, *, message_id: str, token: str) -> dict:
    return {
        "from_user_id": peer,
        "to_user_id": "offline-account",
        "message_id": message_id,
        "context_token": token,
        "item_list": [{"type": weixin.ITEM_TEXT, "text_item": {"text": f"来自 {peer}"}}],
    }


class FakeClientSession:
    """An aiohttp-shaped session which cannot create a real connection."""

    closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        self.closed = True
        return False


class HermesWeixinOfflinePoc(unittest.TestCase):
    def test_o1_provenance_is_fixed_upstream_release(self):
        self.assertEqual(SOURCE_ROOT.name, "hermes-agent-v2026.8.3")
        project = tomllib.loads((SOURCE_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
        self.assertEqual(project["project"]["name"], "hermes-agent")
        self.assertEqual(project["project"]["version"], "0.20.0")
        self.assertEqual(project["project"]["license"], "MIT")
        commit = subprocess.check_output(
            ["git", "-C", str(SOURCE_ROOT), "rev-parse", "HEAD"], text=True
        ).strip()
        tag = subprocess.check_output(
            ["git", "-C", str(SOURCE_ROOT), "describe", "--tags", "--exact-match"], text=True
        ).strip()
        self.assertEqual(commit, EXPECTED_COMMIT)
        self.assertEqual(tag, "v2026.8.3")

    def test_context_tokens_are_isolated_by_account_and_peer_then_restored(self):
        with offline_network():
            store = ContextTokenStore(str(_TEMP_HOME))
            store.set("account-a", "peer-1", "ctx-a-1")
            store.set("account-a", "peer-2", "ctx-a-2")
            store.set("account-b", "peer-1", "ctx-b-1")

            self.assertEqual(store.get("account-a", "peer-1"), "ctx-a-1")
            self.assertEqual(store.get("account-a", "peer-2"), "ctx-a-2")
            self.assertEqual(store.get("account-b", "peer-1"), "ctx-b-1")
            self.assertIsNone(store.get("account-b", "peer-2"))

            persisted = _TEMP_HOME / "weixin" / "accounts" / "account-a.context-tokens.json"
            self.assertEqual(json.loads(persisted.read_text(encoding="utf-8")), {
                "peer-1": "ctx-a-1", "peer-2": "ctx-a-2"
            })
            restarted = ContextTokenStore(str(_TEMP_HOME))
            restarted.restore("account-a")
            restarted.restore("account-b")
            self.assertEqual(restarted.get("account-a", "peer-1"), "ctx-a-1")
            self.assertEqual(restarted.get("account-a", "peer-2"), "ctx-a-2")
            self.assertEqual(restarted.get("account-b", "peer-1"), "ctx-b-1")

    def test_two_fake_peers_get_distinct_message_events_and_sessions(self):
        async def scenario():
            adapter = make_adapter(policy="allowlist", allowed=["peer-a", "peer-b"])
            adapter._poll_session = object()
            adapter._token = ""  # prevents getconfig/typing work in this offline test.
            seen: list[MessageEvent] = []

            async def handler(event: MessageEvent) -> None:
                seen.append(event)

            adapter.handle_message = handler
            await adapter._process_message(inbound("peer-a", message_id="a-1", token="ctx-a"))
            await adapter._process_message(inbound("peer-b", message_id="b-1", token="ctx-b"))
            await asyncio.sleep(0.02)
            return adapter, seen

        with offline_network():
            adapter, seen = asyncio.run(scenario())
        self.assertEqual({event.source.user_id for event in seen}, {"peer-a", "peer-b"})
        self.assertEqual({event.source.chat_id for event in seen}, {"peer-a", "peer-b"})
        keys = {adapter._text_batch_key(event) for event in seen}
        self.assertEqual(len(keys), 2, "两个 peer 不能共享 Gateway 会话")
        self.assertEqual(adapter._token_store.get("offline-account", "peer-a"), "ctx-a")
        self.assertEqual(adapter._token_store.get("offline-account", "peer-b"), "ctx-b")

    def test_disabled_dm_is_dropped_before_token_or_handler(self):
        async def scenario():
            adapter = make_adapter(policy="disabled")
            adapter._poll_session = object()
            handler = AsyncMock()
            adapter.handle_message = handler
            await adapter._process_message(inbound("blocked-peer", message_id="disabled-1", token="must-not-store"))
            await asyncio.sleep(0.01)
            return adapter, handler

        with offline_network():
            adapter, handler = asyncio.run(scenario())
        handler.assert_not_awaited()
        self.assertIsNone(adapter._token_store.get("offline-account", "blocked-peer"))

    def test_pairing_and_allowlist_intake_then_gateway_auth_has_both_deny_and_authorized_paths(self):
        async def intake(policy: str, allowed: list[str] | None = None) -> MessageEvent:
            adapter = make_adapter(policy=policy, allowed=allowed)
            adapter._poll_session = object()
            adapter._token = ""
            captured: list[MessageEvent] = []

            async def handler(event: MessageEvent) -> None:
                captured.append(event)

            adapter.handle_message = handler
            await adapter._process_message(inbound("unapproved-peer", message_id=f"{policy}-1", token="ctx"))
            await asyncio.sleep(0.02)
            self.assertEqual(len(captured), 1)
            self.assertTrue(adapter.enforces_own_access_policy)
            return captured[0]

        async def standard_gateway_dispatch(event: MessageEvent, *, authorized: bool) -> AsyncMock:
            runner = object.__new__(GatewayRunner)
            runner._scale_to_zero_note_real_inbound = lambda: None
            runner._is_user_authorized = lambda _source: authorized
            runner._get_unauthorized_dm_behavior = lambda *_args, **_kwargs: "disabled"
            runner._session_key_for_source = lambda *_args, **_kwargs: "offline-gateway-session"
            runner._peek_session_state = lambda *_args, **_kwargs: None
            runner._is_session_running = lambda *_args, **_kwargs: False
            runner._claim_active_session_slot = lambda *_args, **_kwargs: (None, None)
            state = SimpleNamespace(
                turn=SimpleNamespace(agent=None, started_ts=0.0, lease=None),
                conversation=SimpleNamespace(one_turn_restore=None),
            )
            runner._session_state = lambda *_args, **_kwargs: state
            runner._persist_active_agents = lambda: None
            runner._begin_session_run_generation = lambda *_args, **_kwargs: 1
            runner._restore_moa_one_shot = lambda *_args, **_kwargs: None
            runner._restore_pending_one_turn_model_override = lambda *_args, **_kwargs: None
            runner._release_running_agent_state = lambda *_args, **_kwargs: None
            runner._release_turn_lease = lambda *_args, **_kwargs: None
            runner._external_drain_active = False
            # This is a recording stub, not an AIAgent.  It proves the exact
            # Gateway branch selected without constructing Agent/Provider/tools.
            agent_path = AsyncMock(return_value=None)
            runner._handle_message_with_agent = agent_path
            with (
                patch("hermes_cli.lifecycle.invoke_hook", return_value=[]),
            ):
                result = await runner._handle_message(event)
            self.assertIsNone(result)
            return agent_path

        with offline_network():
            pairing_event = asyncio.run(intake("pairing"))
            # This peer is adapter-allowlisted, so it reaches Gateway; a
            # non-listed peer is rejected by the adapter before this point.
            allowlist_event = asyncio.run(intake("allowlist", ["unapproved-peer"]))
            for event in (pairing_event, allowlist_event):
                denied = asyncio.run(standard_gateway_dispatch(event, authorized=False))
                denied.assert_not_awaited()
                permitted = asyncio.run(standard_gateway_dispatch(event, authorized=True))
                permitted.assert_awaited_once()

    def test_public_hermes_send_routes_weixin_to_fake_transport(self):
        """Cover the public CLI handler and its Weixin route without a subprocess or network."""
        sent: list[tuple[str, str, str]] = []

        async def fake_weixin(pconfig, chat_id, message, media_files=None):
            self.assertEqual(media_files, [])
            sent.append((pconfig.token, chat_id, message))
            return {"success": True, "platform": "weixin", "chat_id": chat_id}

        config = SimpleNamespace(
            platforms={
                Platform.WEIXIN: PlatformConfig(
                    enabled=True,
                    token="offline-token",
                    extra={"account_id": "offline-account"},
                )
            }
        )
        with (
            patch("gateway.config.load_gateway_config", return_value=config),
            patch.object(send_message_tool_module, "_send_weixin", new=fake_weixin),
            patch("model_tools._run_async", side_effect=lambda coroutine: asyncio.run(coroutine)),
            patch.object(hermes_send_cmd, "_load_hermes_env"),
        ):
            with offline_network():
                output = io.StringIO()
                with contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as exited:
                    hermes_send_cmd.cmd_send(SimpleNamespace(
                        to="weixin:wxid_targetpeer",
                        message="公开发送路由测试",
                        file=None,
                        subject=None,
                        list_targets=False,
                        json=True,
                        quiet=False,
                    ))
        self.assertEqual(exited.exception.code, 0)
        result = json.loads(output.getvalue())
        self.assertEqual(result, {"success": True, "platform": "weixin", "chat_id": "wxid_targetpeer"})
        self.assertEqual(sent, [("offline-token", "wxid_targetpeer", "公开发送路由测试")])

    def test_direct_send_builds_one_to_one_ilink_payload_and_uses_peer_token(self):
        async def scenario():
            ContextTokenStore(str(_TEMP_HOME)).set("send-account", "target-peer", "saved-context")
            fake_session = FakeClientSession()
            api_post = AsyncMock(return_value={"ret": 0})
            with (
                patch.object(weixin, "_api_post", api_post),
                patch.object(weixin, "_make_ssl_connector", return_value=None),
                patch.object(weixin.aiohttp, "ClientSession", return_value=fake_session),
            ):
                result = await weixin.send_weixin_direct(
                    extra={"account_id": "send-account", "base_url": "https://ilink.invalid"},
                    token="send-token",
                    chat_id="target-peer",
                    message="仅发送给目标 peer",
                )
            return result, api_post

        with offline_network():
            result, api_post = asyncio.run(scenario())
        self.assertTrue(result["success"])
        self.assertEqual(result["platform"], "weixin")
        self.assertEqual(result["chat_id"], "target-peer")
        self.assertTrue(result["context_token_used"])
        payload = api_post.await_args.kwargs["payload"]
        message = payload["msg"]
        self.assertEqual(api_post.await_args.kwargs["endpoint"], weixin.EP_SEND_MESSAGE)
        self.assertEqual(message["to_user_id"], "target-peer")
        self.assertEqual(message["context_token"], "saved-context")
        self.assertEqual(message["message_type"], weixin.MSG_TYPE_BOT)
        self.assertEqual(message["item_list"], [{"type": weixin.ITEM_TEXT, "text_item": {"text": "仅发送给目标 peer"}}])

    def test_default_transport_failures_are_retried_and_are_a_no_go_finding(self):
        async def run_failure(kind: str, error: Exception) -> tuple[int, list[str]]:
            adapter = make_adapter(policy="allowlist", allowed=["target-peer"])
            adapter._send_session = object()
            adapter._send_chunk_retries = 4  # Hermes v2026.8.3 default.
            calls: list[str] = []

            async def failing_send(*_args, **kwargs):
                calls.append(kwargs["client_id"])
                raise error

            with patch.object(weixin, "_send_message", new=failing_send):
                result = await adapter.send("target-peer", f"failure:{kind}")
            self.assertFalse(result.success)
            return len(calls), calls

        variants = {
            "timeout": asyncio.TimeoutError(),
            "http-4xx": RuntimeError("iLink POST sendmessage HTTP 400"),
            "http-5xx": RuntimeError("iLink POST sendmessage HTTP 503"),
            "bad-json": ValueError("Expecting value: line 1 column 1"),
        }
        with offline_network():
            observations = {kind: asyncio.run(run_failure(kind, error)) for kind, error in variants.items()}
        for kind, (attempts, client_ids) in observations.items():
            self.assertEqual(attempts, 5, f"{kind} 应记录 Hermes 的默认 1+4 次发送行为")
            self.assertEqual(len(set(client_ids)), 1, f"{kind} 的同一逻辑发送会复用 client_id")

    def test_repeated_logical_send_generates_new_client_ids_and_has_no_cross_call_idempotency(self):
        async def scenario():
            adapter = make_adapter(policy="allowlist", allowed=["target-peer"])
            adapter._send_session = object()
            adapter._send_chunk_retries = 0
            client_ids: list[str] = []

            async def successful_send(*_args, **kwargs):
                client_ids.append(kwargs["client_id"])
                return {"ret": 0}

            with patch.object(weixin, "_send_message", new=successful_send):
                first = await adapter.send("target-peer", "相同业务消息")
                second = await adapter.send("target-peer", "相同业务消息")
            self.assertTrue(first.success)
            self.assertTrue(second.success)
            return client_ids

        with offline_network():
            client_ids = asyncio.run(scenario())
        self.assertEqual(len(client_ids), 2)
        self.assertNotEqual(client_ids[0], client_ids[1])
        self.assertTrue(all(value.startswith("hermes-weixin-") for value in client_ids))


def tearDownModule() -> None:
    """The only files this PoC writes are its random /tmp state, then remove it."""
    shutil.rmtree(_TEMP_ROOT, ignore_errors=False)
    if _TEMP_ROOT.exists():
        raise AssertionError(f"临时 HERMES_HOME 清理失败：{_TEMP_ROOT}")


if __name__ == "__main__":
    result = unittest.main(verbosity=2, exit=False).result
    print("\n离线 PoC 结论：未尝试 DNS、网络、登录、扫码、微信发送或真实 AIAgent/Provider/模型工具调用。")
    print("风险证据：v2026.8.3 对 timeout/4xx/5xx/bad JSON 默认重试 1+4 次；独立重复发送生成新 client_id。")
    raise SystemExit(0 if result.wasSuccessful() else 1)
