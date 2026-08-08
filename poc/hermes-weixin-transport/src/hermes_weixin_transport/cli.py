"""Repository CLI: capture a permitted DM token or send one protected text."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from .config import ConfigError, load_config, load_daemon_config
from .state import StateError, TokenState
from .transport import RequestError, parse_send_request, send_once
from .transport import send_bound_once
from .multi_user import MultiUserVault
from .daemon import InternalClient, run_capture_daemon
from .upstream_gate import UpstreamGateError, verify_upstream


def _input_object() -> dict[str, Any]:
    try:
        value = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        raise RequestError("stdin 必须是单个 JSON 对象") from exc
    if not isinstance(value, dict):
        raise RequestError("stdin 必须是单个 JSON 对象")
    return value


def _capture(config, state: TokenState, inbound: dict[str, Any]) -> dict[str, str]:
    # Deliberately access only routing fields.  In particular this does not
    # inspect item_list/text/media/message_id or copy the envelope to state.
    peer = inbound.get("from_user_id")
    recipient = inbound.get("to_user_id")
    context_token = inbound.get("context_token")
    group_marker = inbound.get("room_id") or inbound.get("chat_room_id")
    if (
        not isinstance(peer, str)
        or peer not in config.allowed_from
        or peer == config.account_id
        or recipient != config.account_id
        or bool(group_marker)
        or not isinstance(context_token, str)
        or not context_token
        or len(context_token) > 8192
    ):
        return {"status": "ignored"}
    try:
        state.capture(peer, context_token)
    except StateError:
        return {"status": "rejected", "code": "STATE_UNAVAILABLE"}
    return {"status": "captured"}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="hermes-weixin-transport")
    parser.add_argument("command", choices=("capture", "send", "send-bound", "daemon"))
    parser.add_argument("--config", required=True, help="0600 JSON 配置文件")
    parser.add_argument("--state-dir", required=True, help="0700、绝对路径的状态目录")
    parser.add_argument("--vault-dir", help="多人绑定 vault（0700、绝对路径）")
    parser.add_argument("--server-url", help="本机内部绑定 API 根地址")
    parser.add_argument("--internal-secret-file", help="0600 内部 HMAC 密钥文件")
    return parser


def main(argv: list[str] | None = None) -> int:
    # This is intentionally the first operational action: neither config nor
    # state nor any Hermes module is touched until the gate succeeds.
    try:
        source_root = verify_upstream()
    except UpstreamGateError:
        print("上游来源校验失败", file=sys.stderr)
        return 2
    args = _parser().parse_args(argv)
    try:
        config = load_daemon_config(args.config) if args.command == "daemon" else load_config(args.config)
        state = TokenState(Path(args.state_dir), config)
        if args.command == "daemon":
            if not args.vault_dir or not args.server_url or not args.internal_secret_file:
                raise RequestError("daemon 配置无效")
            from .security import require_private_file
            secret = require_private_file(Path(args.internal_secret_file), kind="内部密钥").read_text().strip()
            if len(secret.encode()) < 32: raise RequestError("内部密钥无效")
            stop = asyncio.Event()
            try: asyncio.run(run_capture_daemon(source_root, config, MultiUserVault(args.vault_dir, config.hmac_key), InternalClient(args.server_url, secret), stop))
            except KeyboardInterrupt: pass
            return 0
        inbound_or_request = _input_object()
        if args.command == "capture":
            outcome = _capture(config, state, inbound_or_request)
        elif args.command == "send-bound":
            if not args.vault_dir or set(inbound_or_request) != {"userId", "generation", "text", "idempotencyKey"}:
                raise RequestError("多人投递参数无效")
            user_id, generation, text, key = inbound_or_request["userId"], inbound_or_request["generation"], inbound_or_request["text"], inbound_or_request["idempotencyKey"]
            if not isinstance(user_id, int) or user_id < 1 or not isinstance(generation, int) or generation < 1:
                raise RequestError("多人投递代次无效")
            # Reuse strict text/key validation without exposing a static peer.
            if not isinstance(text, str) or not text or len(text) > 2000 or not isinstance(key, str) or not 1 <= len(key) <= 256:
                raise RequestError("多人投递正文无效")
            outcome = asyncio.run(send_bound_once(source_root, config, MultiUserVault(args.vault_dir, config.hmac_key), user_id, generation, text, key))
        else:
            request = parse_send_request(inbound_or_request, config.allowed_from)
            outcome = asyncio.run(send_once(source_root, config, state, request))
    except (ConfigError, RequestError, StateError):
        print("请求或本地安全校验失败", file=sys.stderr)
        return 2
    print(json.dumps(outcome, ensure_ascii=False, separators=(",", ":")))
    return 0 if outcome.get("status") in {"captured", "ignored", "sent"} else 1
