"""Filesystem checks used before reading overlay configuration or state."""

from __future__ import annotations

import os
import stat
from pathlib import Path


class SecurityError(RuntimeError):
    pass


_REPOSITORY_ROOT = Path(__file__).resolve().parents[4]


def normalized_external_path(path: Path, *, kind: str, allow_missing_final: bool = False) -> Path:
    """Return an absolute external path only after rejecting every symlink ancestor.

    ``Path.resolve`` alone is insufficient here: it follows a malicious parent
    symlink before the final-component check can see it.
    """
    if not path.is_absolute():
        raise SecurityError(f"{kind} 必须使用绝对路径")
    normalized = Path(os.path.abspath(os.fspath(path)))
    try:
        normalized.relative_to(_REPOSITORY_ROOT)
    except ValueError:
        pass
    else:
        raise SecurityError(f"{kind} 必须位于仓库外")
    parents = list(reversed(normalized.parents))
    # '/' is also checked; every remaining ancestor must exist and be a real
    # directory.  The final component is validated by its type-specific user.
    for ancestor in parents:
        try:
            entry = ancestor.lstat()
        except OSError as exc:
            raise SecurityError(f"{kind} 的祖先目录不可用") from exc
        if stat.S_ISLNK(entry.st_mode) or not stat.S_ISDIR(entry.st_mode):
            raise SecurityError(f"{kind} 不得经过符号链接祖先目录")
    if not allow_missing_final and not os.path.lexists(normalized):
        raise SecurityError(f"{kind} 不可用")
    return normalized


def _owned_regular(path: Path, *, mode: int) -> os.stat_result:
    try:
        lst = path.lstat()
    except OSError as exc:
        raise SecurityError("受控文件不可用") from exc
    if stat.S_ISLNK(lst.st_mode) or not stat.S_ISREG(lst.st_mode):
        raise SecurityError("受控文件必须是普通文件，不能是符号链接")
    if lst.st_uid != os.geteuid() or lst.st_nlink != 1 or stat.S_IMODE(lst.st_mode) != mode:
        raise SecurityError("受控文件的属主、硬链接数或权限不安全")
    return lst


def require_private_file(path: Path, *, kind: str = "配置文件") -> Path:
    normalized = normalized_external_path(path, kind=kind)
    _owned_regular(normalized, mode=0o600)
    try:
        if normalized.resolve(strict=True) != normalized:
            raise SecurityError(f"{kind} 不得经过符号链接")
    except OSError as exc:
        raise SecurityError(f"{kind} 不可用") from exc
    return normalized


def ensure_state_directory(path: Path) -> None:
    """Create or validate a user-owned, non-symlink 0700 state directory."""
    normalized = normalized_external_path(path, kind="状态目录", allow_missing_final=True)
    try:
        os.mkdir(normalized, mode=0o700)
    except FileExistsError:
        pass
    except OSError as exc:
        raise SecurityError("无法创建状态目录") from exc
    try:
        lst = normalized.lstat()
    except OSError as exc:
        raise SecurityError("状态目录不可用") from exc
    if stat.S_ISLNK(lst.st_mode) or not stat.S_ISDIR(lst.st_mode):
        raise SecurityError("状态目录必须是目录，不能是符号链接")
    if lst.st_uid != os.geteuid() or stat.S_IMODE(lst.st_mode) != 0o700:
        raise SecurityError("状态目录必须由当前用户拥有且权限为 0700")


def require_state_directory(path: Path) -> None:
    normalized = normalized_external_path(path, kind="状态目录")
    try:
        lst = normalized.lstat()
    except OSError as exc:
        raise SecurityError("状态目录不可用") from exc
    if stat.S_ISLNK(lst.st_mode) or not stat.S_ISDIR(lst.st_mode):
        raise SecurityError("状态目录必须是非链接目录")
    if lst.st_uid != os.geteuid() or stat.S_IMODE(lst.st_mode) != 0o700:
        raise SecurityError("状态目录必须由当前用户拥有且权限为 0700")


def open_private_lock(path: Path) -> int:
    """Open/create a 0600 lock atomically, waiting safely for a racing creator."""
    normalized = normalized_external_path(path, kind="状态锁", allow_missing_final=True)
    flags = os.O_RDWR | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    for _attempt in range(32):
        try:
            fd = os.open(normalized, flags, 0o600)
            os.fchmod(fd, 0o600)
            return fd
        except FileExistsError:
            open_flags = os.O_RDWR | (os.O_NOFOLLOW if hasattr(os, "O_NOFOLLOW") else 0)
            try:
                fd = os.open(normalized, open_flags)
                entry = os.fstat(fd)
                if not stat.S_ISREG(entry.st_mode) or entry.st_uid != os.geteuid() or entry.st_nlink != 1 or stat.S_IMODE(entry.st_mode) != 0o600:
                    os.close(fd)
                    raise SecurityError("状态锁的属主、硬链接数或权限不安全")
                return fd
            except FileNotFoundError:
                # A racing creator may have failed after creating then removing
                # the path; retry its complete atomic creation sequence.
                continue
            except OSError as exc:
                raise SecurityError("无法安全打开状态锁") from exc
        except OSError as exc:
            raise SecurityError("无法安全创建状态锁") from exc
    raise SecurityError("状态锁初始化竞争未收敛")
