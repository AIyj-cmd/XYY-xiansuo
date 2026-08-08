"""Fail-closed provenance gate for the fixed local Hermes source tree."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path
from typing import Any


class UpstreamGateError(RuntimeError):
    """The local source copy differs from the explicitly accepted upstream."""


def _manifest_path() -> Path:
    return Path(__file__).resolve().parents[2] / "UPSTREAM_MANIFEST.json"


def _load_manifest() -> dict[str, Any]:
    try:
        raw = json.loads(_manifest_path().read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or not isinstance(raw.get("upstream"), dict):
            raise ValueError("invalid schema")
        return raw
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise UpstreamGateError("上游清单不可用") from exc


def _run_git(source: Path, *args: str) -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", str(source), *args], text=True, stderr=subprocess.DEVNULL
        ).strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        raise UpstreamGateError("无法验证固定 Hermes Git 来源") from exc


def _regular_file_under(root: Path, relative: str) -> Path:
    candidate = root / relative
    try:
        st = candidate.lstat()
        resolved = candidate.resolve(strict=True)
    except OSError as exc:
        raise UpstreamGateError("上游受控文件不可用") from exc
    if candidate.is_symlink() or not resolved.is_file() or st.st_nlink != 1:
        raise UpstreamGateError("上游受控文件必须是非链接普通文件")
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise UpstreamGateError("上游受控文件越出固定目录") from exc
    return resolved


def verify_upstream(source_dir: str | os.PathLike[str] | None = None) -> Path:
    """Verify every approved identity before Hermes can be imported.

    No configuration, state, default home, or network client is accessed here.
    The source path must be supplied explicitly (or through the dedicated
    HERMES_SOURCE_DIR environment variable); there is deliberately no ~/.hermes
    fallback.
    """
    manifest = _load_manifest()
    upstream = manifest["upstream"]
    raw_source = source_dir or os.environ.get("HERMES_SOURCE_DIR")
    if not raw_source:
        raise UpstreamGateError("必须显式提供 HERMES_SOURCE_DIR")
    source = Path(raw_source)
    try:
        source_lstat = source.lstat()
        root = source.resolve(strict=True)
    except OSError as exc:
        raise UpstreamGateError("固定 Hermes 源码目录不可用") from exc
    # Directory link counts naturally increase with child directories; only a
    # symlink can redirect this root.  Regular consumed files are required to
    # have exactly one hard link below.
    if source.is_symlink() or not root.is_dir():
        raise UpstreamGateError("固定 Hermes 源码目录必须是非链接目录")

    if _run_git(root, "remote", "get-url", "origin") != upstream["repository"]:
        raise UpstreamGateError("Hermes remote 不匹配")
    if _run_git(root, "describe", "--tags", "--exact-match") != upstream["tag"]:
        raise UpstreamGateError("Hermes tag 不匹配")
    if _run_git(root, "rev-parse", "HEAD") != upstream["commit"]:
        raise UpstreamGateError("Hermes commit 不匹配")
    if _run_git(root, "show", "-s", "--format=%T", "HEAD") != upstream["tree"]:
        raise UpstreamGateError("Hermes tree 不匹配")
    if _run_git(root, "status", "--porcelain=v1", "--untracked-files=all"):
        raise UpstreamGateError("Hermes 源码副本必须保持干净")

    files = manifest.get("files")
    if not isinstance(files, dict):
        raise UpstreamGateError("上游清单缺少受控文件哈希")
    content: dict[str, bytes] = {}
    for relative, expected_hash in files.items():
        if not isinstance(relative, str) or not isinstance(expected_hash, str):
            raise UpstreamGateError("上游清单文件哈希格式无效")
        data = _regular_file_under(root, relative).read_bytes()
        if hashlib.sha256(data).hexdigest() != expected_hash:
            raise UpstreamGateError("Hermes 受控文件哈希不匹配")
        content[relative] = data
    try:
        project = content["pyproject.toml"].decode("utf-8")
        license_text = content["LICENSE"].decode("utf-8")
    except (KeyError, UnicodeDecodeError) as exc:
        raise UpstreamGateError("上游元数据文件不可读") from exc
    if f'name = "{upstream["package_name"]}"' not in project or f'version = "{upstream["version"]}"' not in project:
        raise UpstreamGateError("Hermes 包版本不匹配")
    if f'license = "{upstream["license"]}"' not in project or not license_text.startswith("MIT License\n"):
        raise UpstreamGateError("Hermes 许可证不匹配")
    return root
