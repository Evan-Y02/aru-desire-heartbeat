#!/usr/bin/env bash
set -Eeuo pipefail

# Redact credentials without printing or storing the original stream anywhere.
sed -E \
  -e 's/("(pairingToken|token|secret|authorization)"[[:space:]]*:[[:space:]]*")[^"]*/\1[REDACTED]/Ig' \
  -e 's/((pairingToken|token|secret)=)[^&[:space:]]+/\1[REDACTED]/Ig' \
  -e 's/((Authorization|Bearer)[=:[:space:]]+)[A-Za-z0-9._~+\/-]{8,}/\1[REDACTED]/Ig'
