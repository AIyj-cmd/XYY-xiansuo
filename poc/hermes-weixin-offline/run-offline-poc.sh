#!/usr/bin/env bash
set -euo pipefail

# This runner deliberately executes only the fixed local Hermes source copy.
# It never starts a gateway, performs QR login, or contacts iLink.
readonly HERMES_SOURCE_DIR="${HERMES_SOURCE_DIR:-/tmp/hermes-agent-v2026.8.3}"
readonly HERMES_PYTHON="${HERMES_PYTHON:-${HERMES_SOURCE_DIR}/.venv/bin/python}"
readonly TEST_FILE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/test_offline_poc.py"

if [[ ! -f "${HERMES_SOURCE_DIR}/pyproject.toml" ]]; then
  echo "未找到固定 Hermes 源码：${HERMES_SOURCE_DIR}" >&2
  exit 2
fi

if [[ ! -x "${HERMES_PYTHON}" ]]; then
  cat >&2 <<EOF
未找到 Hermes 专用 Python：${HERMES_PYTHON}

请仅在固定源码副本中创建临时测试环境：
  cd ${HERMES_SOURCE_DIR}
  uv sync --frozen --extra dev --extra messaging

随后重新运行：
  ./poc/hermes-weixin-offline/run-offline-poc.sh
EOF
  exit 2
fi

export HERMES_OFFLINE_POC_SOURCE="${HERMES_SOURCE_DIR}"
exec "${HERMES_PYTHON}" "${TEST_FILE}"
