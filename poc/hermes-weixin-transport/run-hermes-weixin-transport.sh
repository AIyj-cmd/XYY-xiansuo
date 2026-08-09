#!/usr/bin/env bash
set -euo pipefail

# This CLI only uses the fixed local source after its Python provenance gate
# passes.  It does not start Hermes Gateway, QR login, polling, or any agent.
readonly OVERLAY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly HERMES_SOURCE_DIR="${HERMES_SOURCE_DIR:-/tmp/hermes-agent-v2026.8.3}"
readonly HERMES_PYTHON="${HERMES_PYTHON:-${HERMES_SOURCE_DIR}/.venv/bin/python}"

if [[ ! -x "${HERMES_PYTHON}" ]]; then
  echo "未找到固定 Hermes 专用 Python" >&2
  exit 2
fi

export HERMES_SOURCE_DIR
export PYTHONPATH="${OVERLAY_DIR}/src${PYTHONPATH:+:${PYTHONPATH}}"
exec "${HERMES_PYTHON}" -m hermes_weixin_transport "$@"
