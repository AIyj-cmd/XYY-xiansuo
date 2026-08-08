"""Strict, explicit configuration.  This module never reads ~/.hermes."""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .security import SecurityError, require_private_file


_ID_RE = re.compile(r"^[A-Za-z0-9_.@-]{1,128}$")


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class TransportConfig:
    account_id: str
    ilink_token: str
    allowed_from: tuple[str, ...]
    hmac_key: bytes


def _id(value: Any, field: str) -> str:
    if not isinstance(value, str) or not _ID_RE.fullmatch(value):
        raise ConfigError(f"配置字段 {field} 无效")
    return value


def load_config(path: str | Path) -> TransportConfig:
    config_path = Path(path)
    try:
        config_path = require_private_file(config_path, kind="配置文件")
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, SecurityError, json.JSONDecodeError) as exc:
        raise ConfigError("配置文件必须是当前用户拥有的 0600 JSON 普通文件") from exc
    if not isinstance(raw, dict) or set(raw) != {"account_id", "ilink_token", "allowed_from", "hmac_key"}:
        raise ConfigError("配置字段必须且只能包含 account_id、ilink_token、allowed_from、hmac_key")
    account_id = _id(raw.get("account_id"), "account_id")
    token = raw.get("ilink_token")
    if not isinstance(token, str) or not token or len(token) > 8192:
        raise ConfigError("配置字段 ilink_token 无效")
    allowed_raw = raw.get("allowed_from")
    if not isinstance(allowed_raw, list) or not 1 <= len(allowed_raw) <= 10:
        raise ConfigError("allowed_from 必须是 1 至 10 个静态用户 ID")
    allowed = tuple(_id(item, "allowed_from") for item in allowed_raw)
    if len(set(allowed)) != len(allowed):
        raise ConfigError("allowed_from 不能重复")
    encoded_key = raw.get("hmac_key")
    if not isinstance(encoded_key, str):
        raise ConfigError("配置字段 hmac_key 无效")
    try:
        hmac_key = base64.b64decode(encoded_key, validate=True)
    except Exception as exc:
        raise ConfigError("配置字段 hmac_key 必须为 base64") from exc
    if len(hmac_key) < 32:
        raise ConfigError("hmac_key 解码后至少需要 32 字节")
    return TransportConfig(account_id, token, allowed, hmac_key)
