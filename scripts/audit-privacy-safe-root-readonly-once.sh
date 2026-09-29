#!/usr/bin/env bash
set -Eeuo pipefail
set +x

readonly SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}" 2>/dev/null)"
readonly SCRIPT_DIR="$(dirname -- "$SCRIPT_PATH")"
readonly HELPER_PATH="$SCRIPT_DIR/audit-privacy-safe-root-readonly-once.mjs"
readonly CORE_PATH="$SCRIPT_DIR/privacy-safe-root-audit-core.mjs"

blocked() {
  printf '%s\n' \
    'PRIVACY_SAFE_ROOT_AUDIT=INCONCLUSIVE' \
    'AUDIT_PERMISSION_ERROR=1'
  exit 2
}

[[ ${EUID} -eq 0 ]] || blocked
[[ $# -eq 0 ]] || blocked
[[ -f "$SCRIPT_PATH" && ! -L "$SCRIPT_PATH" ]] || blocked
[[ -f "$HELPER_PATH" && ! -L "$HELPER_PATH" ]] || blocked
[[ -f "$CORE_PATH" && ! -L "$CORE_PATH" ]] || blocked

/usr/bin/bash -n "$SCRIPT_PATH" >/dev/null 2>&1 || blocked
/usr/bin/node --check "$HELPER_PATH" >/dev/null 2>&1 || blocked
/usr/bin/node --check "$CORE_PATH" >/dev/null 2>&1 || blocked

readonly WRITE_API_PATTERN='\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rename|renameSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|mkdir|mkdirSync|chmod|chmodSync|chown|chownSync|link|linkSync|symlink|symlinkSync|truncate|truncateSync)\s*\('
readonly SYSTEMD_MUTATION_PATTERN='systemctl[[:space:]]+(start|stop|restart|reload|daemon-reload|enable|disable|mask|unmask|reset-failed|kill|set-property|edit|revert)'
readonly NETWORK_WRITE_PATTERN='\b(POST|PUT|PATCH|DELETE|CONNECT)\b'

if /usr/bin/grep -Eq "$WRITE_API_PATTERN" "$HELPER_PATH" "$CORE_PATH"; then blocked; fi
if /usr/bin/grep -Eq "$SYSTEMD_MUTATION_PATTERN" "$SCRIPT_PATH" "$HELPER_PATH" "$CORE_PATH"; then blocked; fi
if /usr/bin/grep -Eq "$NETWORK_WRITE_PATTERN" "$HELPER_PATH" "$CORE_PATH"; then blocked; fi

exec /usr/bin/node "$HELPER_PATH"
