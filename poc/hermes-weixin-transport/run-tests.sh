#!/usr/bin/env bash
set -euo pipefail
readonly OVERLAY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly HERMES_PYTHON="${HERMES_PYTHON:-python3}"
: "${HERMES_SOURCE_DIR:?测试也必须显式提供 HERMES_SOURCE_DIR}"
: "${HERMES_PRIVATE_ROOT:?测试也必须显式提供 HERMES_PRIVATE_ROOT}"
export HERMES_SOURCE_DIR
export PYTHONPATH="${OVERLAY_DIR}/src${PYTHONPATH:+:${PYTHONPATH}}"
exec "${HERMES_PYTHON}" -m unittest discover -s "${OVERLAY_DIR}/test" -v
