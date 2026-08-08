"""One-shot, text-only iLink send path with no Hermes gateway involvement."""

from __future__ import annotations

import asyncio
import hashlib
import importlib
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

from .config import TransportConfig
from .state import StateError, TokenState


ILINK_BASE_URL = "https://ilinkai.weixin.qq.com"
_HTTP_STATUS_RE = re.compile(r"\bHTTP\s+(\d{3})\b")


@dataclass(frozen=True)
class SendRequest:
    peer: str
    text: str
    idempotency_key: str


class RequestError(RuntimeError):
    pass


def parse_send_request(raw: object, allowed_from: tuple[str, ...]) -> SendRequest:
    if not isinstance(raw, dict) or set(raw) != {"peer", "text", "idempotencyKey"}:
        raise RequestError("输入必须只包含 peer、text、idempotencyKey")
    peer, text, key = raw.get("peer"), raw.get("text"), raw.get("idempotencyKey")
    if not isinstance(peer, str) or peer not in allowed_from:
        raise RequestError("目标不在静态 allowlist 中")
    if not isinstance(text, str) or not text or len(text) > 2000:
        raise RequestError("仅支持 1 至 2000 个字符的纯文本")
    if not isinstance(key, str) or not 1 <= len(key) <= 256 or any(ord(ch) < 33 or ord(ch) > 126 for ch in key):
        raise RequestError("idempotencyKey 必须是 1 至 256 个可打印 ASCII 字符")
    return SendRequest(peer=peer, text=text, idempotency_key=key)


def deterministic_client_id(config: TransportConfig, request: SendRequest) -> str:
    material = f"{config.account_id}\0{request.peer}\0{request.idempotency_key}".encode("utf-8")
    return "xiansuo-hermes-" + hashlib.sha256(material).hexdigest()


def _load_weixin_api(source_root: Path):
    """Import exactly after the caller has passed the provenance gate."""
    source_text = str(source_root)
    if source_text not in sys.path:
        sys.path.insert(0, source_text)
    return importlib.import_module("gateway.platforms.weixin")


async def _call_upstream_once(source_root: Path, config: TransportConfig, request: SendRequest, context_token: str) -> dict[str, Any]:
    weixin = _load_weixin_api(source_root)
    connector = weixin._make_ssl_connector()
    try:
        async with weixin.aiohttp.ClientSession(connector=connector, trust_env=False) as session:
            # The only iLink endpoint this overlay may call.  No getconfig,
            # typing, media, polling, retries, or fallback path exists here.
            return await weixin._api_post(
                session,
                base_url=ILINK_BASE_URL,
                endpoint=weixin.EP_SEND_MESSAGE,
                payload={
                    "msg": {
                        "from_user_id": "",
                        "to_user_id": request.peer,
                        "client_id": deterministic_client_id(config, request),
                        "message_type": weixin.MSG_TYPE_BOT,
                        "message_state": weixin.MSG_STATE_FINISH,
                        "context_token": context_token,
                        "item_list": [{"type": weixin.ITEM_TEXT, "text_item": {"text": request.text}}],
                    }
                },
                token=config.ilink_token,
                timeout_ms=weixin.API_TIMEOUT_MS,
            )
    finally:
        if connector is not None:
            await connector.close()


def _result(status: str, code: str, request: SendRequest) -> dict[str, str]:
    return {"status": status, "code": code, "idempotencyKey": request.idempotency_key}


def _classify_exception(exc: BaseException, request: SendRequest) -> dict[str, str]:
    if isinstance(exc, asyncio.TimeoutError):
        return _result("result_unknown", "ILINK_SEND_TIMEOUT", request)
    status_match = _HTTP_STATUS_RE.search(str(exc))
    if status_match:
        status = int(status_match.group(1))
        if 400 <= status < 500:
            return _result("permanent_failure", "ILINK_PROVIDER_REJECTED", request)
        if status >= 500:
            return _result("result_unknown", "ILINK_SEND_RESULT_UNKNOWN", request)
    # Disconnects, TLS failures and malformed JSON can happen after an HTTP
    # request was accepted.  Do not retry or reinterpret them as unsent.
    return _result("result_unknown", "ILINK_SEND_RESULT_UNKNOWN", request)


PostOnce = Callable[[Path, TransportConfig, SendRequest, str], Awaitable[dict[str, Any]]]


async def send_once(
    source_root: Path,
    config: TransportConfig,
    state: TokenState,
    request: SendRequest,
    *,
    post_once: PostOnce = _call_upstream_once,
) -> dict[str, str]:
    try:
        context_token = state.token_for(request.peer)
    except StateError:
        return _result("permanent_failure", "ILINK_STALE_CONTEXT_TOKEN", request)
    if not context_token:
        # No tokenless send is permitted, including after a restart.
        return _result("permanent_failure", "ILINK_STALE_CONTEXT_TOKEN", request)
    try:
        response = await post_once(source_root, config, request, context_token)
    except Exception as exc:  # status classification must never leak credentials
        return _classify_exception(exc, request)
    if not isinstance(response, dict):
        return _result("result_unknown", "ILINK_SEND_RESULT_UNKNOWN", request)
    if response.get("ret") == 0:
        return _result("sent", "ILINK_SENT", request)
    return _result("permanent_failure", "ILINK_PROVIDER_REJECTED", request)
