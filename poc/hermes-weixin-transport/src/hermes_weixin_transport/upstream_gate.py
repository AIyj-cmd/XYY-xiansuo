"""Fail-closed provenance gate for the fixed local Hermes source tree."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
import types
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class UpstreamGateError(RuntimeError):
    """The local source copy differs from the explicitly accepted upstream."""

_REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
_SYSTEM_TEMP_ROOTS = (Path("/tmp"), Path("/var/tmp"), Path("/dev/shm"))

@dataclass(frozen=True)
class _RuntimePaths:
    root: Path
    source: Path
    python: Path
    identities: tuple[tuple[Path, int, int], ...]

def _under(path: Path, root: Path) -> bool:
    try: path.relative_to(root); return True
    except ValueError: return False

def _reject_untrusted_location(path: Path, kind: str) -> None:
    if _under(path, _REPOSITORY_ROOT) or any(_under(path, root) for root in _SYSTEM_TEMP_ROOTS):
        raise UpstreamGateError(f"{kind} 不得位于仓库或系统临时目录")

def _safe_ancestor_chain(path: Path, kind: str) -> tuple[tuple[Path, int, int], ...]:
    """Check every component through / and retain lstat identities for recheck."""
    identities: list[tuple[Path, int, int]] = []
    cursor = path
    while True:
        try:
            entry = cursor.lstat()
        except OSError as exc:
            raise UpstreamGateError(f"{kind} 祖先目录不可用") from exc
        if (not stat.S_ISDIR(entry.st_mode) or stat.S_ISLNK(entry.st_mode)
                or entry.st_uid not in {0, os.geteuid()} or stat.S_IMODE(entry.st_mode) & 0o022):
            raise UpstreamGateError(f"{kind} 的祖先目录不安全")
        identities.append((cursor, entry.st_dev, entry.st_ino))
        if cursor.parent == cursor:
            return tuple(identities)
        cursor = cursor.parent

def _private_root(value: str | os.PathLike[str] | None = None) -> Path:
    raw = value or os.environ.get("HERMES_PRIVATE_ROOT")
    if not raw or not os.path.isabs(raw): raise UpstreamGateError("必须显式提供绝对 HERMES_PRIVATE_ROOT")
    requested = Path(raw)
    try: root = requested.resolve(strict=True); entry = requested.lstat()
    except OSError as exc: raise UpstreamGateError("Hermes 私有根目录不可用") from exc
    if requested.is_symlink() or root != requested or not stat.S_ISDIR(entry.st_mode) or entry.st_uid != os.geteuid() or stat.S_IMODE(entry.st_mode) != 0o700:
        raise UpstreamGateError("Hermes 私有根目录必须由当前用户拥有、非链接且权限精确0700")
    _reject_untrusted_location(root, "Hermes 私有根目录")
    _safe_ancestor_chain(root, "Hermes 私有根目录")
    return root

def _secure_descendant(path: Path, private_root: Path, *, directory: bool, exact_mode: int | None, kind: str, allow_root_owner: bool = False) -> Path:
    if not path.is_absolute(): raise UpstreamGateError(f"{kind} 必须为绝对路径")
    try: resolved = path.resolve(strict=True); entry = path.lstat()
    except OSError as exc: raise UpstreamGateError(f"{kind} 不可用") from exc
    if path.is_symlink() or resolved != path or not _under(resolved, private_root) or _under(resolved, _REPOSITORY_ROOT) or any(_under(resolved, root) for root in _SYSTEM_TEMP_ROOTS):
        raise UpstreamGateError(f"{kind} 必须位于私有根目录内，且不得经过链接、仓库或临时目录")
    if (directory and not stat.S_ISDIR(entry.st_mode)) or (not directory and not stat.S_ISREG(entry.st_mode)):
        raise UpstreamGateError(f"{kind} 类型不安全")
    allowed_owners = {os.geteuid()}
    if allow_root_owner:
        allowed_owners.add(0)
    if entry.st_uid not in allowed_owners or (entry.st_nlink != 1 and not directory):
        owner_message = "root 或当前用户" if allow_root_owner else "当前用户"
        raise UpstreamGateError(f"{kind} 必须由{owner_message}拥有且无硬链接")
    if exact_mode is not None and stat.S_IMODE(entry.st_mode) != exact_mode:
        raise UpstreamGateError(f"{kind} 权限必须精确为 {exact_mode:04o}")
    if exact_mode is None and (stat.S_IMODE(entry.st_mode) & 0o022):
        raise UpstreamGateError(f"{kind} 不得被组或其他用户写入")
    cursor = resolved if directory else resolved.parent
    while cursor != private_root:
        ancestor = cursor.lstat()
        if cursor.is_symlink() or not stat.S_ISDIR(ancestor.st_mode) or ancestor.st_uid != os.geteuid() or (stat.S_IMODE(ancestor.st_mode) & 0o022):
            raise UpstreamGateError(f"{kind} 私有根目录下的祖先目录不安全")
        cursor = cursor.parent
    return resolved

def _inspect_runtime_paths(source_dir: str | os.PathLike[str] | None = None, python_path: str | os.PathLike[str] | None = None, private_root: str | os.PathLike[str] | None = None) -> _RuntimePaths:
    root = _private_root(private_root)
    raw_source = source_dir or os.environ.get("HERMES_SOURCE_DIR")
    raw_python = python_path or os.environ.get("HERMES_PYTHON")
    if not raw_source or not raw_python: raise UpstreamGateError("必须显式提供 HERMES_SOURCE_DIR 和 HERMES_PYTHON")
    source = _secure_descendant(Path(raw_source), root, directory=True, exact_mode=0o700, kind="固定 Hermes 源码目录")
    python = _secure_descendant(Path(raw_python), root, directory=False, exact_mode=None, kind="Hermes Python", allow_root_owner=True)
    if not os.access(python, os.X_OK): raise UpstreamGateError("Hermes Python 必须可执行")
    if _under(python, source): raise UpstreamGateError("Hermes Python 不得位于 Hermes 源码 checkout 内")
    paths = (root, source, python)
    identities = tuple((path, path.lstat().st_dev, path.lstat().st_ino) for path in paths)
    identities += _safe_ancestor_chain(root, "Hermes 私有根目录")
    return _RuntimePaths(root, source, python, identities)

def _recheck_runtime_paths(runtime: _RuntimePaths) -> None:
    # Re-run structural checks first, then require the identities captured
    # before the critical provenance work to remain unchanged.
    refreshed = _inspect_runtime_paths(runtime.source, runtime.python, runtime.root)
    if refreshed.identities != runtime.identities:
        raise UpstreamGateError("Hermes 路径在校验期间发生变化")

def validate_runtime_paths(source_dir: str | os.PathLike[str] | None = None, python_path: str | os.PathLike[str] | None = None, private_root: str | os.PathLike[str] | None = None) -> tuple[Path, Path, Path]:
    runtime = _inspect_runtime_paths(source_dir, python_path, private_root)
    _recheck_runtime_paths(runtime)
    return runtime.root, runtime.source, runtime.python

@dataclass(frozen=True)
class VerifiedUpstream:
    root: Path
    weixin_source: bytes

def load_verified_weixin(snapshot: VerifiedUpstream | Path):
    """Load the already-hashed source bytes, never import a mutable pathname."""
    if isinstance(snapshot, Path):
        # Compatibility is deliberately limited to an already injected module
        # used by offline unit tests; no pathname import is ever performed.
        injected = sys.modules.get("gateway.platforms.weixin")
        if injected is None: raise UpstreamGateError("Hermes 模块必须来自已验证字节快照")
        return injected
    module = types.ModuleType("xiansuo_verified_weixin")
    module.__file__ = str(snapshot.root / "gateway/platforms/weixin.py")
    module.__package__ = "gateway.platforms"
    try:
        # The entrypoint itself is compiled from the verified bytes above. Its
        # pinned package dependencies are resolved only after the same clean
        # Git/tree provenance gate has accepted this immutable source root.
        root_text = str(snapshot.root)
        if root_text not in sys.path: sys.path.insert(0, root_text)
        exec(compile(snapshot.weixin_source, module.__file__, "exec"), module.__dict__)
    except Exception as exc:
        raise UpstreamGateError("已验证 Hermes 模块无法加载") from exc
    return module


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


def verify_upstream(source_dir: str | os.PathLike[str] | None = None) -> VerifiedUpstream:
    """Verify every approved identity before Hermes can be imported.

    No configuration, state, default home, or network client is accessed here.
    The source path must be supplied explicitly (or through the dedicated
    HERMES_SOURCE_DIR environment variable); there is deliberately no ~/.hermes
    fallback.
    """
    manifest = _load_manifest()
    upstream = manifest["upstream"]
    runtime = _inspect_runtime_paths(source_dir)
    root = runtime.source

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
    weixin = content.get("gateway/platforms/weixin.py")
    if not isinstance(weixin, bytes): raise UpstreamGateError("上游微信模块快照不可用")
    _recheck_runtime_paths(runtime)
    return VerifiedUpstream(root=root, weixin_source=weixin)
