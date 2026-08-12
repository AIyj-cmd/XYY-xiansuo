#!/usr/bin/env bash
set -euo pipefail

# This CLI only uses the fixed local source after its Python provenance gate
# passes.  It does not start Hermes Gateway, QR login, polling, or any agent.
readonly OVERLAY_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
 : "${HERMES_SOURCE_DIR:?必须显式提供私有绝对 HERMES_SOURCE_DIR}"
 : "${HERMES_PYTHON:?必须显式提供私有绝对 HERMES_PYTHON}"
 : "${HERMES_PRIVATE_ROOT:?必须显式提供私有绝对 HERMES_PRIVATE_ROOT}"
readonly HERMES_SOURCE_DIR HERMES_PYTHON HERMES_PRIVATE_ROOT
readonly REPOSITORY_ROOT="$(cd -- "$OVERLAY_DIR/../.." && pwd -P)"
readonly CURRENT_UID="$(id -u)"
canonical_path() { realpath -e -- "$1"; }
is_under() { [[ "$1" = "$2" || "$1" = "$2"/* ]]; }
reject_untrusted() { ! is_under "$1" "$REPOSITORY_ROOT" && ! is_under "$1" /tmp && ! is_under "$1" /var/tmp && ! is_under "$1" /dev/shm; }
safe_owner() { [[ "$1" = "$CURRENT_UID" || "$1" = 0 ]]; }
safe_mode() { local mode="$1"; (( (8#$mode & 8#022) == 0 )); }
path_identity() { stat -c '%d:%i' -- "$1"; }
assert_private_ancestors() {
  local cursor="$HERMES_PRIVATE_ROOT" mode owner
  while :; do
    [[ -d "$cursor" && ! -L "$cursor" ]] || return 1
    mode="$(stat -c '%a' "$cursor")"; owner="$(stat -c '%u' "$cursor")"
    safe_owner "$owner" && safe_mode "$mode" || return 1
    [[ "$cursor" = / ]] && return 0
    cursor="$(dirname -- "$cursor")"
  done
}
assert_private_root() {
  [[ "$HERMES_PRIVATE_ROOT" = /* ]] || return 1
  local resolved mode; resolved="$(canonical_path "$HERMES_PRIVATE_ROOT")" || return 1
  [[ "$resolved" = "$HERMES_PRIVATE_ROOT" && -d "$resolved" && ! -L "$resolved" ]] || return 1
  mode="$(stat -c '%a' "$resolved")"
  [[ "$(stat -c '%u' "$resolved")" = "$CURRENT_UID" && "$mode" = 700 ]] && reject_untrusted "$resolved" && assert_private_ancestors
}
assert_descendant() {
  local candidate="$1" kind="$2" expected_type="$3" exact_mode="$4" resolved cursor mode
  [[ "$candidate" = /* ]] || return 1
  resolved="$(canonical_path "$candidate")" || return 1
  [[ "$resolved" = "$candidate" && ! -L "$resolved" ]] || return 1
  is_under "$resolved" "$HERMES_PRIVATE_ROOT" && reject_untrusted "$resolved" || return 1
  [[ "$expected_type" = dir && -d "$resolved" || "$expected_type" = file && -f "$resolved" ]] || return 1
  mode="$(stat -c '%a' "$resolved")"
  if [[ "$expected_type" = file ]]; then
    [[ "$(stat -c '%u' "$resolved")" = "$CURRENT_UID" || "$(stat -c '%u' "$resolved")" = 0 ]] || return 1
  else
    [[ "$(stat -c '%u' "$resolved")" = "$CURRENT_UID" ]] || return 1
  fi
  if [[ "$expected_type" = file ]]; then [[ "$(stat -c '%h' "$resolved")" = 1 && -x "$resolved" ]] || return 1; fi
  if [[ -n "$exact_mode" ]]; then [[ "$mode" = "$exact_mode" ]] || return 1; else safe_mode "$mode" || return 1; fi
  cursor="$resolved"; [[ "$expected_type" = file ]] && cursor="$(dirname -- "$cursor")"
  while [[ "$cursor" != "$HERMES_PRIVATE_ROOT" ]]; do
    mode="$(stat -c '%a' "$cursor")"; [[ -d "$cursor" && ! -L "$cursor" && "$(stat -c '%u' "$cursor")" = "$CURRENT_UID" ]] && safe_mode "$mode" || return 1
    cursor="$(dirname -- "$cursor")"
  done
}
assert_private_root || { echo "Hermes 私有根目录不安全" >&2; exit 2; }
assert_descendant "$HERMES_SOURCE_DIR" "源码" dir 700 || { echo "Hermes 源码目录不安全" >&2; exit 2; }
assert_descendant "$HERMES_PYTHON" "Python" file '' || { echo "Hermes Python 不安全" >&2; exit 2; }
is_under "$HERMES_PYTHON" "$HERMES_SOURCE_DIR" && { echo "Hermes Python 不得位于源码 checkout" >&2; exit 2; }
readonly PRIVATE_ROOT_ID="$(path_identity "$HERMES_PRIVATE_ROOT")" SOURCE_ID="$(path_identity "$HERMES_SOURCE_DIR")" PYTHON_ID="$(path_identity "$HERMES_PYTHON")"
assert_private_root && assert_descendant "$HERMES_SOURCE_DIR" "源码" dir 700 && assert_descendant "$HERMES_PYTHON" "Python" file '' && [[ "$(path_identity "$HERMES_PRIVATE_ROOT")" = "$PRIVATE_ROOT_ID" && "$(path_identity "$HERMES_SOURCE_DIR")" = "$SOURCE_ID" && "$(path_identity "$HERMES_PYTHON")" = "$PYTHON_ID" ]] || { echo "Hermes 路径在校验期间发生变化或不安全" >&2; exit 2; }

export HERMES_SOURCE_DIR
export PYTHONPATH="${OVERLAY_DIR}/src"
exec env -i PATH=/usr/bin:/bin LANG="${LANG:-C.UTF-8}" HERMES_PRIVATE_ROOT="$HERMES_PRIVATE_ROOT" HERMES_SOURCE_DIR="$HERMES_SOURCE_DIR" HERMES_PYTHON="$HERMES_PYTHON" PYTHONPATH="$PYTHONPATH" "$HERMES_PYTHON" -m hermes_weixin_transport "$@"
