#!/usr/bin/env bash
set -euo pipefail

# PM2 may itself have been started from an application shell.  Start the
# manager with a deliberately empty environment so DB/JWT/AI values cannot
# reach the Python process.  The only dynamic input is the private config path
# forwarded as argv by the dedicated PM2 template.
readonly OVERLAY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
: "${HERMES_SOURCE_DIR:?必须提供固定 Hermes 源码目录}"
: "${HERMES_PYTHON:?必须提供固定 Hermes Python 路径}"
readonly SAFE_PATH="${PATH:?PATH 不可用}"

exec env -i \
  PATH="$SAFE_PATH" \
  LANG="${LANG:-C.UTF-8}" \
  HERMES_SOURCE_DIR="$HERMES_SOURCE_DIR" \
  HERMES_PYTHON="$HERMES_PYTHON" \
  "$OVERLAY_DIR/run-hermes-weixin-transport.sh" account-manager "$@"
