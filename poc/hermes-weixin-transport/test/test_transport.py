#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import stat
import tempfile
import threading
import unittest
from pathlib import Path


OVERLAY = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(OVERLAY / "src"))

from hermes_weixin_transport.cli import _capture
from hermes_weixin_transport.config import ConfigError, load_config
from hermes_weixin_transport.state import StateError, TokenState
from hermes_weixin_transport.transport import RequestError, SendRequest, deterministic_client_id, parse_send_request, send_once
from hermes_weixin_transport.upstream_gate import UpstreamGateError, verify_upstream


SOURCE = Path(os.environ.get("HERMES_SOURCE_DIR", "/tmp/hermes-agent-v2026.8.3"))


class TransportOverlayTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="xiansuo-hermes-transport-")
        self.root = Path(self.temp.name)
        self.config_path = self.root / "config.json"
        self.state_dir = self.root / "state"
        self._write_config()
        self.config = load_config(self.config_path)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _write_config(self, **override: object) -> None:
        raw: dict[str, object] = {
            "account_id": "overlay-account",
            "ilink_token": "test-ilink-secret",
            "allowed_from": ["peer-a", "peer-b"],
            "hmac_key": base64.b64encode(b"h" * 32).decode("ascii"),
        }
        raw.update(override)
        self.config_path.write_text(json.dumps(raw), encoding="utf-8")
        self.config_path.chmod(0o600)

    def test_01_gate_verifies_the_fixed_clean_upstream_before_import(self) -> None:
        source = verify_upstream(SOURCE)
        self.assertEqual(source, SOURCE.resolve())
        manifest = json.loads((OVERLAY / "UPSTREAM_MANIFEST.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["upstream"]["commit"], "3c27eb6234bf91b8ceee9e9071591b31e9b148cb")

    def test_02_config_requires_0600_and_static_allowlist_of_1_to_10(self) -> None:
        self.config_path.chmod(0o644)
        with self.assertRaises(ConfigError):
            load_config(self.config_path)

    def test_02b_direct_cli_paths_must_be_external_and_have_no_symlink_ancestor(self) -> None:
        with self.assertRaises(ConfigError):
            load_config(OVERLAY / "README.md")
        real = self.root / "real"; real.mkdir()
        external_config = real / "config.json"
        external_config.write_text(self.config_path.read_text(encoding="utf-8"), encoding="utf-8"); external_config.chmod(0o600)
        linked = self.root / "linked"; os.symlink(real, linked)
        with self.assertRaises(ConfigError):
            load_config(linked / "config.json")
        with self.assertRaises(StateError):
            TokenState(linked / "state", self.config)
        self.config_path.chmod(0o600)
        self._write_config(allowed_from=[])
        with self.assertRaises(ConfigError):
            load_config(self.config_path)
        self._write_config(allowed_from=[f"peer-{n}" for n in range(11)])
        with self.assertRaises(ConfigError):
            load_config(self.config_path)

    def test_03_ignored_inbound_never_creates_or_writes_state_and_never_uses_content(self) -> None:
        state = TokenState(self.state_dir, self.config)
        for inbound in (
            {"from_user_id": "unknown", "to_user_id": "overlay-account", "context_token": "x", "message_id": "m-1", "item_list": [{"text": "private"}]},
            {"from_user_id": "overlay-account", "to_user_id": "overlay-account", "context_token": "x"},
            {"from_user_id": "peer-a", "to_user_id": "overlay-account", "room_id": "group", "context_token": "x"},
            {"from_user_id": "peer-a", "to_user_id": "overlay-account", "item_list": [{"text": "no-token"}]},
        ):
            self.assertEqual(_capture(self.config, state, inbound), {"status": "ignored"})
        self.assertFalse(self.state_dir.exists())

    def test_04_capture_persists_only_latest_token_atomically_with_hmac_refs(self) -> None:
        state = TokenState(self.state_dir, self.config)
        self.assertEqual(_capture(self.config, state, {"from_user_id": "peer-a", "to_user_id": "overlay-account", "context_token": "old", "message_id": "m-1", "item_list": [{"text": "ignored"}]}), {"status": "captured"})
        self.assertEqual(_capture(self.config, state, {"from_user_id": "peer-a", "to_user_id": "overlay-account", "context_token": "latest", "message_id": "m-2", "item_list": [{"media": "ignored"}]}), {"status": "captured"})
        self.assertEqual(state.token_for("peer-a"), "latest")
        state_file = self.state_dir / "context-tokens.json"
        raw = state_file.read_text(encoding="utf-8")
        self.assertNotIn("m-1", raw)
        self.assertNotIn("m-2", raw)
        self.assertNotIn("ignored", raw)
        self.assertNotIn("overlay-account", raw)
        self.assertNotIn("peer-a", raw)
        self.assertNotIn("latest", raw)
        self.assertNotIn("old", raw)
        serialized = json.loads(raw)
        self.assertEqual(set(serialized), {"schema", "entries", "entries_mac"})
        self.assertEqual(serialized["schema"], 2)
        self.assertEqual(stat.S_IMODE(state_file.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.state_dir.stat().st_mode), 0o700)
        restarted = TokenState(self.state_dir, self.config)
        self.assertEqual(restarted.token_for("peer-a"), "latest")

    def test_05_stable_client_id_and_single_call_success(self) -> None:
        state = TokenState(self.state_dir, self.config)
        state.capture("peer-a", "captured-context")
        request = parse_send_request({"peer": "peer-a", "text": "一次文本", "idempotencyKey": "job-42"}, self.config.allowed_from)
        self.assertEqual(deterministic_client_id(self.config, request), deterministic_client_id(self.config, request))
        calls: list[str] = []
        async def post(_source, _config, passed, token):
            calls.append(f"{passed.peer}:{token}")
            return {"ret": 0}
        outcome = asyncio.run(send_once(SOURCE, self.config, state, request, post_once=post))
        self.assertEqual(outcome, {"status": "sent", "code": "ILINK_SENT", "idempotencyKey": "job-42"})
        self.assertEqual(calls, ["peer-a:captured-context"])

    def test_06_stale_context_never_calls_transport(self) -> None:
        state = TokenState(self.state_dir, self.config)
        request = SendRequest("peer-a", "text", "key")
        async def forbidden(*_args):
            raise AssertionError("must not submit without a context token")
        outcome = asyncio.run(send_once(SOURCE, self.config, state, request, post_once=forbidden))
        self.assertEqual(outcome["status"], "permanent_failure")
        self.assertEqual(outcome["code"], "ILINK_STALE_CONTEXT_TOKEN")
        self.assertFalse(self.state_dir.exists())

    def test_07_timeout_disconnect_5xx_and_bad_json_are_unknown_without_retry(self) -> None:
        state = TokenState(self.state_dir, self.config)
        state.capture("peer-a", "context")
        request = SendRequest("peer-a", "text", "key")
        variants = [asyncio.TimeoutError(), OSError("disconnected"), RuntimeError("iLink POST sendmessage HTTP 503"), ValueError("bad json")]
        for error in variants:
            calls = 0
            async def post(*_args, error=error):
                nonlocal calls
                calls += 1
                raise error
            outcome = asyncio.run(send_once(SOURCE, self.config, state, request, post_once=post))
            self.assertEqual(outcome["status"], "result_unknown")
            self.assertEqual(calls, 1)

    def test_08_explicit_4xx_and_nonzero_ret_are_permanent_and_input_is_text_only(self) -> None:
        state = TokenState(self.state_dir, self.config)
        state.capture("peer-a", "context")
        request = SendRequest("peer-a", "text", "key")
        async def rejected(*_args):
            raise RuntimeError("iLink POST sendmessage HTTP 400")
        self.assertEqual(asyncio.run(send_once(SOURCE, self.config, state, request, post_once=rejected))["status"], "permanent_failure")
        async def ret_rejected(*_args):
            return {"ret": 1}
        self.assertEqual(asyncio.run(send_once(SOURCE, self.config, state, request, post_once=ret_rejected))["status"], "permanent_failure")
        with self.assertRaises(RequestError):
            parse_send_request({"peer": "peer-a", "text": "x" * 2001, "idempotencyKey": "k"}, self.config.allowed_from)
        with self.assertRaises(RequestError):
            parse_send_request({"peer": "peer-a", "text": "ok", "idempotencyKey": "k", "media": "no"}, self.config.allowed_from)

    def test_09_tampered_hmac_state_is_fail_closed(self) -> None:
        state = TokenState(self.state_dir, self.config)
        state.capture("peer-a", "context")
        state_file = self.state_dir / "context-tokens.json"
        raw = json.loads(state_file.read_text(encoding="utf-8"))
        reference = next(iter(raw["entries"]))
        raw["entries"][reference]["ciphertext"] = "dGFtcGVyZWQ="
        state_file.write_text(json.dumps(raw), encoding="utf-8")
        state_file.chmod(0o600)
        request = SendRequest("peer-a", "text", "key")
        outcome = asyncio.run(send_once(SOURCE, self.config, state, request))
        self.assertEqual(outcome["code"], "ILINK_STALE_CONTEXT_TOKEN")

    def test_09b_legacy_raw_state_is_migrated_to_encrypted_minimal_state(self) -> None:
        self.state_dir.mkdir(mode=0o700); self.state_dir.chmod(0o700)
        token = "legacy-context"; peer = "peer-a"
        reference = hmac.new(self.config.hmac_key, f"{self.config.account_id}\0{peer}\0{token}".encode("utf-8"), hashlib.sha256).hexdigest()
        tokens = {peer: {"token": token, "ref": reference}}
        legacy = {"schema": 1, "account_id": self.config.account_id, "tokens": tokens, "refs_mac": hmac.new(self.config.hmac_key, json.dumps(tokens, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"), hashlib.sha256).hexdigest()}
        state_file = self.state_dir / "context-tokens.json"; state_file.write_text(json.dumps(legacy), encoding="utf-8"); state_file.chmod(0o600)
        state = TokenState(self.state_dir, self.config)
        self.assertEqual(state.token_for(peer), token)
        migrated = state_file.read_text(encoding="utf-8")
        self.assertNotIn(self.config.account_id, migrated); self.assertNotIn(peer, migrated); self.assertNotIn(token, migrated)
        self.assertEqual(json.loads(migrated)["schema"], 2)

    def test_10_cold_start_concurrent_capture_pressure_is_stable(self) -> None:
        for round_number in range(10):
            state = TokenState(self.root / f"state-{round_number}", self.config)
            failures: list[BaseException] = []
            start = threading.Barrier(12)
            def capture(value: str) -> None:
                try:
                    start.wait(timeout=5)
                    state.capture("peer-a", value)
                except BaseException as exc:  # test records unexpected lock failures
                    failures.append(exc)
            threads = [threading.Thread(target=capture, args=(f"context-{round_number}-{number}",)) for number in range(12)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=10)
            self.assertFalse(any(thread.is_alive() for thread in threads))
            self.assertEqual(failures, [])
            self.assertIn(state.token_for("peer-a"), {f"context-{round_number}-{number}" for number in range(12)})
            raw = (state.directory / "context-tokens.json").read_text(encoding="utf-8")
            self.assertNotIn("peer-a", raw)
            self.assertEqual(json.loads(raw)["schema"], 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
