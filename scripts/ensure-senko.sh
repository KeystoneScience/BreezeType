#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_SCRIPT="$ROOT_DIR/scripts/install-senko.sh"

if [[ "${BREEZE_SKIP_SENKO_INSTALL:-0}" == "1" ]]; then
  echo "Skipping Senko install (BREEZE_SKIP_SENKO_INSTALL=1)."
  exit 0
fi

if [[ ! -f "$INSTALL_SCRIPT" ]]; then
  echo "Missing Senko installer script: $INSTALL_SCRIPT"
  exit 1
fi

if [[ ! -x "$INSTALL_SCRIPT" ]]; then
  chmod +x "$INSTALL_SCRIPT"
fi

"$INSTALL_SCRIPT"
