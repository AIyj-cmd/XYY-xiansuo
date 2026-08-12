"""One-shot, text-only iLink send path with no Hermes gateway involvement."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

from .config import TransportConfig
from .state import StateError, TokenState
from .upstream_gate import VerifiedUpstream, load_verified_weixin


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


def _load_weixin_api(snapshot: VerifiedUpstream):
    return load_verified_weixin(snapshot)


async def _call_upstream_once(source_root: VerifiedUpstream, config: TransportConfig, request: SendRequest, context_token: str) -> dict[str, Any]:
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


def _result(status: str, code: str, response_shape: str, request: SendRequest) -> dict[str, str]:
    # This is the complete stdout contract consumed by the Gateway.  The
    # response shape is a fixed enum: it intentionally never includes a raw
    # provider value, field name, message body, token, peer or request key.
    return {
        "status": status,
        "code": code,
        "responseShape": response_shape,
        "idempotencyKey": request.idempotency_key,
    }


def _classify_exception(exc: BaseException, request: SendRequest) -> dict[str, str]:
    if isinstance(exc, asyncio.TimeoutError):
        return _result("result_unknown", "ILINK_SEND_TIMEOUT", "timeout", request)
    status_match = _HTTP_STATUS_RE.search(str(exc))
    if status_match:
        status = int(status_match.group(1))
        if 400 <= status < 500:
            return _result("permanent_failure", "ILINK_PROVIDER_REJECTED", "http_client_error", request)
        if status >= 500:
            return _result("result_unknown", "ILINK_SEND_RESULT_UNKNOWN", "http_server_error", request)
    # Disconnects, TLS failures and malformed JSON can happen after an HTTP
    # request was accepted.  Do not retry or reinterpret them as unsent.
    return _result("result_unknown", "ILINK_SEND_RESULT_UNKNOWN", "transport_error", request)


def _is_real_int(value: object) -> bool:
    # bool is a subclass of int in Python and must never be a provider code.
    return isinstance(value, int) and not isinstance(value, bool)


def _classify_response(response: object, request: SendRequest) -> dict[str, str]:
    """Reduce an untrusted provider response to the fixed stdout contract."""
    if not isinstance(response, dict):
        return _result("result_unknown", "ILINK_SEND_RESULT_UNKNOWN", "non_object", request)
    if not response:
        # Tencent's pinned official plugin uses an exact empty object as a
        # successful send fixture.  The prior live Pilot raw body was not
        # retained, so this is a narrow audited contract, not a reconstruction.
        return _result("sent", "ILINK_SENT", "empty_object", request)

    has_ret = "ret" in response
    has_errcode = "errcode" in response
    if not has_ret and not has_errcode:
        return _result("result_unknown", "ILINK_SEND_RESULT_UNKNOWN", "unrecognized_object", request)

    ret = response.get("ret")
    errcode = response.get("errcode")
    if (has_ret and not _is_real_int(ret)) or (has_errcode and not _is_real_int(errcode)):
        return _result("result_unknown", "ILINK_SEND_RESULT_UNKNOWN", "invalid_code_type", request)

    # A zero success signal and a nonzero failure signal disagree.  Preserve
    # the single-attempt boundary and require manual reconciliation instead of
    # choosing one untrusted interpretation.
    if has_ret and has_errcode and ((ret == 0) != (errcode == 0)):
        return _result("result_unknown", "ILINK_SEND_RESULT_UNKNOWN", "conflicting_codes", request)

    # A definite numeric provider rejection wins over HTTP success.  Values
    # and other response fields are deliberately neither retained nor output.
    if has_ret and ret != 0 and has_errcode and errcode != 0:
        return _result("permanent_failure", "ILINK_PROVIDER_REJECTED", "both_codes_nonzero", request)
    if has_ret and ret != 0:
        return _result("permanent_failure", "ILINK_PROVIDER_REJECTED", "ret_nonzero", request)
    if has_errcode and errcode != 0:
        return _result("permanent_failure", "ILINK_PROVIDER_REJECTED", "errcode_nonzero", request)

    if has_ret:
        if has_errcode:
            return _result("sent", "ILINK_SENT", "ret_zero_errcode_zero", request)
        return _result("sent", "ILINK_SENT", "ret_zero", request)

    # The pinned official runtime can acknowledge a submitted send with only
    # errcode=0.  Its value is validated above as a real integer, so accepting
    # this narrow shape does not reinterpret bools, strings or null as success.
    return _result("sent", "ILINK_SENT", "errcode_zero", request)


PostOnce = Callable[[VerifiedUpstream, TransportConfig, SendRequest, str], Awaitable[dict[str, Any]]]


async def send_once(
    source_root: VerifiedUpstream,
    config: TransportConfig,
    state: TokenState,
    request: SendRequest,
    *,
    post_once: PostOnce = _call_upstream_once,
) -> dict[str, str]:
    try:
        context_token = state.token_for(request.peer)
    except StateError:
        return _result("permanent_failure", "ILINK_STALE_CONTEXT_TOKEN", "not_attempted", request)
    if not context_token:
        # No tokenless send is permitted, including after a restart.
        return _result("permanent_failure", "ILINK_STALE_CONTEXT_TOKEN", "not_attempted", request)
    try:
        response = await post_once(source_root, config, request, context_token)
    except Exception as exc:  # status classification must never leak credentials
        return _classify_exception(exc, request)
    return _classify_response(response, request)


async def send_bound_once(source_root: VerifiedUpstream, config: TransportConfig, vault: Any, user_id: int, generation: int, text: str, idempotency_key: str, *, post_once: PostOnce = _call_upstream_once) -> dict[str, str]:
    """Send only after resolving an exact user/generation from the private vault."""
    try:
        binding = vault.get(user_id, generation)
    except Exception:
        binding = None
    request = SendRequest(peer="", text=text, idempotency_key=idempotency_key)
    if not binding or not isinstance(binding.get("peer"), str) or not isinstance(binding.get("token"), str):
        return _result("permanent_failure", "ILINK_STALE_CONTEXT_TOKEN", "not_attempted", request)
    request = SendRequest(peer=binding["peer"], text=text, idempotency_key=idempotency_key)
    try:
        response = await post_once(source_root, config, request, binding["token"])
    except Exception as exc:
        return _classify_exception(exc, request)
    return _classify_response(response, request)

async def send_account_bound_once(source_root: VerifiedUpstream, vault: Any, user_id: int, generation: int, account_ref: str, text: str, idempotency_key: str) -> dict[str, str]:
    """Exact per-account send: no static config, default account or fallback."""
    request = SendRequest(peer="", text=text, idempotency_key=idempotency_key)
    try: entry = vault.get(account_ref)
    except Exception: entry = None
    if not entry or entry.get("lifecycle") != "active" or entry.get("userId") != user_id or entry.get("generation") != generation:
        return _result("permanent_failure", "ILINK_STALE_CONTEXT_TOKEN", "not_attempted", request)
    if not all(isinstance(entry.get(key),str) and entry.get(key) for key in ("providerAccountId","token","baseUrl","target","context")):
        return _result("permanent_failure", "ILINK_STALE_CONTEXT_TOKEN", "not_attempted", request)
    request = SendRequest(peer=str(entry["target"]), text=text, idempotency_key=idempotency_key)
    weixin = _load_weixin_api(source_root); connector = weixin._make_ssl_connector()
    try:
        async with weixin.aiohttp.ClientSession(connector=connector, trust_env=False) as session:
            response = await weixin._send_message(session, base_url=str(entry["baseUrl"]), token=str(entry["token"]), to=str(entry["target"]), text=text, context_token=str(entry["context"]), client_id="xiansuo-hermes-" + hashlib.sha256(f"{account_ref}\0{idempotency_key}".encode()).hexdigest())
    except Exception as exc: return _classify_exception(exc, request)
    finally:
        if connector is not None: await connector.close()
    return _classify_response(response, request)
