#!/usr/bin/env bash
set -euo pipefail
readonly OVERLAY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly HERMES_PYTHON="${HERMES_PYTHON:-python3}"
export HERMES_SOURCE_DIR="${HERMES_SOURCE_DIR:-/tmp/hermes-agent-v2026.8.3}"
export PYTHONPATH="${OVERLAY_DIR}/src${PYTHONPATH:+:${PYTHONPATH}}"
exec "${HERMES_PYTHON}" -m unittest discover -s "${OVERLAY_DIR}/test" -v
