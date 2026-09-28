#!/usr/bin/env bash
set -Eeuo pipefail
set +x

readonly SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
readonly SCRIPT_DIR="$(dirname -- "$SCRIPT_PATH")"
readonly HELPER_PATH="$SCRIPT_DIR/audit-production-readonly-once.mjs"

fail() {
  printf 'AUDIT_BLOCKED: %s\n' "$1" >&2
  exit 77
}

[[ ${EUID} -eq 0 ]] || fail 'root is required to read protected production state and journal'
[[ -f "$SCRIPT_PATH" && ! -L "$SCRIPT_PATH" ]] || fail 'audit shell script is not a regular file'
[[ -f "$HELPER_PATH" && ! -L "$HELPER_PATH" ]] || fail 'audit helper is not a regular file'

/usr/bin/bash -n "$SCRIPT_PATH" || fail 'bash syntax check failed'
/usr/bin/node --check "$HELPER_PATH" || fail 'node syntax check failed'

readonly SHELL_DANGER_PATTERN='(^|[;&|[:space:]])(rm|mv|cp|install|tee|kill|chmod|chown|git)([[:space:]]|$)'
GT_CHARACTER="$(printf '\076')"
readonly GT_CHARACTER
readonly SHELL_WRITE_REDIRECT_PATTERN="(^|[^<])${GT_CHARACTER}{1,2}([^${GT_CHARACTER}&]|$)"
readonly SYSTEMD_MUTATION_PATTERN='systemctl[[:space:]]+(start|stop|restart|reload|daemon-reload|enable|disable|mask|unmask|reset-failed|kill|set-property|edit|revert)'
readonly HELPER_WRITE_API_PATTERN='\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rename|renameSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|mkdir|mkdirSync|chmod|chmodSync|chown|chownSync|link|linkSync|symlink|symlinkSync|truncate|truncateSync)\s*\('
readonly NETWORK_WRITE_PATTERN='\b(POST|PUT|PATCH|DELETE|CONNECT)\b'

if /usr/bin/grep -En "$SHELL_DANGER_PATTERN" "$SCRIPT_PATH"; then
  fail 'dangerous shell command detected'
fi
if /usr/bin/grep -En "$SHELL_WRITE_REDIRECT_PATTERN" "$SCRIPT_PATH"; then
  fail 'write redirection detected'
fi
if /usr/bin/grep -En "$SYSTEMD_MUTATION_PATTERN" "$SCRIPT_PATH" "$HELPER_PATH"; then
  fail 'systemd mutation detected'
fi
if /usr/bin/grep -En "$HELPER_WRITE_API_PATTERN" "$HELPER_PATH"; then
  fail 'filesystem write API detected'
fi
if /usr/bin/grep -En "$NETWORK_WRITE_PATTERN" "$HELPER_PATH"; then
  fail 'network write method detected'
fi

exec /usr/bin/node "$HELPER_PATH"
