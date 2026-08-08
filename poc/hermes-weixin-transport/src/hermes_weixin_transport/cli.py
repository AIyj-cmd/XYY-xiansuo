"""Repository CLI: capture a permitted DM token or send one protected text."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from .config import ConfigError, load_config
from .state import StateError, TokenState
from .transport import RequestError, parse_send_request, send_once
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
    parser.add_argument("command", choices=("capture", "send"))
    parser.add_argument("--config", required=True, help="0600 JSON 配置文件")
    parser.add_argument("--state-dir", required=True, help="0700、绝对路径的状态目录")
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
        config = load_config(args.config)
        state = TokenState(Path(args.state_dir), config)
        inbound_or_request = _input_object()
        if args.command == "capture":
            outcome = _capture(config, state, inbound_or_request)
        else:
            request = parse_send_request(inbound_or_request, config.allowed_from)
            outcome = asyncio.run(send_once(source_root, config, state, request))
    except (ConfigError, RequestError, StateError):
        print("请求或本地安全校验失败", file=sys.stderr)
        return 2
    print(json.dumps(outcome, ensure_ascii=False, separators=(",", ":")))
    return 0 if outcome.get("status") in {"captured", "ignored", "sent"} else 1
