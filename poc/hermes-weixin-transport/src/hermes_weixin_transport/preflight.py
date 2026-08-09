"""Machine-readable, offline-only checks for the Hermes deployment unit."""
from __future__ import annotations

import importlib, os, platform, subprocess, sys, tempfile
from pathlib import Path
from typing import Any

from .account_manager import AccountManager, HermesPrimitiveProvider, load_account_manager_config
from .security import ensure_state_directory, require_private_file, require_state_directory


def _node_version() -> str:
    completed = subprocess.run(["node", "--version"], check=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=5)
    return completed.stdout.strip()


def _runtime_platform() -> tuple[str, str, str, str]:
    node = _node_version()
    if not node.startswith("v") or tuple(int(part) for part in node[1:].split(".")[:2]) < (22, 13):
        raise ValueError("Node 必须至少为 22.13")
    if sys.version_info < (3, 11): raise ValueError("Python 必须至少为 3.11")
    operating_system, architecture = platform.system().lower(), platform.machine().lower()
    if operating_system != "linux" or architecture not in {"x86_64", "aarch64"}:
        raise ValueError("仅支持 Linux x86_64/aarch64 离线服务单元")
    return node, platform.python_version(), operating_system, architecture


def _fixed_fields(config: Any) -> None:
    if config.host not in {"127.0.0.1", "::1"} or config.port != 38117:
        raise ValueError("manager 必须固定监听 127.0.0.1:38117 或 [::1]:38117")
    if config.enabled:
        raise ValueError("离线 preflight 要求 manager enabled=false")


def _gateway_environment() -> None:
    """Check only path/switch metadata; never read business application env."""
    required = {
        "ILINK_POC_TRANSPORT": "hermes", "ILINK_GATEWAY_HOST": "127.0.0.1",
        "ILINK_GATEWAY_PORT": "38116", "ILINK_POC_LIVE_ENABLED": "false",
        "ILINK_HERMES_TRANSPORT_ENABLED": "false",
    }
    for key, expected in required.items():
        if os.environ.get(key) != expected:
            raise ValueError(f"{key} 必须为 {expected}")
    for key in ("ILINK_POC_STATE_DIR", "ILINK_HERMES_STATE_DIR"):
        value = os.environ.get(key)
        if not value: raise ValueError(f"{key} 不可用")
        require_state_directory(Path(value))
    secret_file = os.environ.get("ILINK_GATEWAY_SECRET_FILE")
    if not secret_file: raise ValueError("ILINK_GATEWAY_SECRET_FILE 不可用")
    require_private_file(Path(secret_file), kind="Gateway Secret 文件")


def run_preflight(config_path: Path, source_root: Path) -> dict[str, Any]:
    """Validate only local files/imports. No socket, DNS, child service or DB."""
    config = load_account_manager_config(config_path)
    _fixed_fields(config)
    _gateway_environment()
    importlib.import_module("qrcode")
    node, python, operating_system, architecture = _runtime_platform()
    # Constructing the manager only opens the encrypted local vault; it never
    # reconciles, calls the provider, or starts a thread.
    manager = AccountManager(config, HermesPrimitiveProvider(source_root))
    manager.readyz(source_root)
    return {
        "status": "ready",
        "offline": True,
        "managerEnabled": False,
        "node": node, "python": python, "os": operating_system, "arch": architecture,
        "checks": {"upstream": "ok", "imports": "ok", "config": "ok", "vault": "ok", "switches": "ok"},
    }


def run_dry_run(source_root: Path) -> dict[str, Any]:
    """Use a temporary disabled config and empty vault; never bind or connect."""
    with tempfile.TemporaryDirectory(prefix="xiansuo-hermes-dry-run-") as root:
        root_path = Path(root)
        vault = root_path / "vault"; vault.mkdir(mode=0o700); ensure_state_directory(vault)
        config_path = root_path / "manager.json"
        config_path.write_text('{"host":"127.0.0.1","port":38117,"vault_dir":"%s","vault_key":"%s","manager_secret":"%s","server_url":"http://127.0.0.1:3000","internal_secret":"%s","enabled":false}' % (vault, "A" * 44, "m" * 32, "i" * 32))
        config_path.chmod(0o600)
        previous = {key: os.environ.get(key) for key in ("ILINK_POC_TRANSPORT", "ILINK_GATEWAY_HOST", "ILINK_GATEWAY_PORT", "ILINK_POC_LIVE_ENABLED", "ILINK_HERMES_TRANSPORT_ENABLED", "ILINK_POC_STATE_DIR", "ILINK_HERMES_STATE_DIR", "ILINK_GATEWAY_SECRET_FILE")}
        ledger = root_path / "ledger"; ledger.mkdir(mode=0o700); ensure_state_directory(ledger)
        state = root_path / "state"; state.mkdir(mode=0o700); ensure_state_directory(state)
        secret = root_path / "gateway.secret"; secret.write_text("g" * 32); secret.chmod(0o600)
        os.environ.update({"ILINK_POC_TRANSPORT":"hermes","ILINK_GATEWAY_HOST":"127.0.0.1","ILINK_GATEWAY_PORT":"38116","ILINK_POC_LIVE_ENABLED":"false","ILINK_HERMES_TRANSPORT_ENABLED":"false","ILINK_POC_STATE_DIR":str(ledger),"ILINK_HERMES_STATE_DIR":str(state),"ILINK_GATEWAY_SECRET_FILE":str(secret)})
        try: result = run_preflight(config_path, source_root)
        finally:
            for key, value in previous.items():
                if value is None: os.environ.pop(key, None)
                else: os.environ[key] = value
    return {"status": "dry_run_ok", "offline": True, "network": "not_used", "businessDatabase": "not_used", "residentProcess": "not_started", "checks": result["checks"]}
