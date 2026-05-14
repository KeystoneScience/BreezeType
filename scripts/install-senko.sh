#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${VENV_DIR:-$ROOT_DIR/.venv-senko}"

is_compatible_python() {
  "$1" - <<'PY' >/dev/null 2>&1
import sys
version = sys.version_info[:2]
sys.exit(0 if (3, 10) <= version < (3, 14) else 1)
PY
}

resolve_python_bin() {
  if [[ -n "${PYTHON_BIN:-}" ]]; then
    if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
      echo "Missing Python interpreter: $PYTHON_BIN" >&2
      return 1
    fi
    if ! is_compatible_python "$PYTHON_BIN"; then
      echo "Python interpreter is not compatible with Senko: $PYTHON_BIN" >&2
      echo "Senko requires Python >=3.10,<3.14." >&2
      return 1
    fi
    echo "$PYTHON_BIN"
    return 0
  fi

  local candidate
  for candidate in python python3 python3.12 python3.11 python3.10 python3.13; do
    if command -v "$candidate" >/dev/null 2>&1 && is_compatible_python "$candidate"; then
      echo "$candidate"
      return 0
    fi
  done

  echo "Could not find a Python interpreter compatible with Senko." >&2
  echo "Senko requires Python >=3.10,<3.14. Set PYTHON_BIN to a compatible interpreter." >&2
  return 1
}

resolve_venv_python() {
  if [[ -x "$VENV_DIR/bin/python" ]]; then
    echo "$VENV_DIR/bin/python"
    return 0
  fi
  if [[ -x "$VENV_DIR/Scripts/python.exe" ]]; then
    echo "$VENV_DIR/Scripts/python.exe"
    return 0
  fi
  echo "$VENV_DIR/bin/python"
}

PYTHON_BIN="$(resolve_python_bin)" || exit 1
VENV_PYTHON="$(resolve_venv_python)"

if [[ -x "$VENV_PYTHON" ]]; then
  if ! "$VENV_PYTHON" - "$PYTHON_BIN" <<'PY' >/dev/null 2>&1
import pathlib
import shutil
import sys

expected = pathlib.Path(shutil.which(sys.argv[1]) or sys.argv[1]).resolve()
actual = pathlib.Path(getattr(sys, "_base_executable", sys.executable)).resolve()
sys.exit(0 if actual == expected else 1)
PY
  then
    echo "Existing Senko virtualenv uses a different Python; recreating $VENV_DIR"
    rm -rf "$VENV_DIR"
    VENV_PYTHON="$(resolve_venv_python)"
  fi
fi

if [[ -x "$VENV_PYTHON" ]] && ! is_compatible_python "$VENV_PYTHON"; then
  echo "Existing Senko virtualenv uses an incompatible Python; recreating $VENV_DIR"
  rm -rf "$VENV_DIR"
  VENV_PYTHON="$(resolve_venv_python)"
fi

if [[ ! -x "$VENV_PYTHON" ]]; then
  echo "Creating virtualenv at $VENV_DIR with $PYTHON_BIN"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
  VENV_PYTHON="$(resolve_venv_python)"
fi

if [[ ! -x "$VENV_PYTHON" ]]; then
  echo "Virtualenv Python was not created at $VENV_DIR"
  exit 1
fi

if [[ "${FORCE_REINSTALL:-0}" != "1" ]]; then
  if "$VENV_PYTHON" - <<'PY' >/dev/null 2>&1
import importlib.util
import sys
sys.exit(0 if importlib.util.find_spec("senko") else 1)
PY
  then
    echo "Senko already installed in $VENV_DIR; skipping reinstall."
    "$VENV_PYTHON" - <<'PY'
import senko
print(f"Senko installed: {getattr(senko, '__version__', 'unknown')}")
PY
    echo "Diarization will use: $VENV_PYTHON"
    exit 0
  fi
fi

echo "Installing Senko diarization dependencies into $VENV_DIR"
"$VENV_PYTHON" -m pip install --upgrade pip
if ! "$VENV_PYTHON" -m pip install --upgrade "senko>=0.1.0"; then
  echo "PyPI package not found; installing Senko directly from GitHub."
  "$VENV_PYTHON" -m pip install --upgrade \
    "git+https://github.com/narcotic-sh/senko.git"
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  TARGET="${MACOSX_DEPLOYMENT_TARGET:-14.0}"
  ARCH="$(uname -m)"
  HDBSCAN_VERSION="$("$VENV_PYTHON" - <<'PY'
from importlib import metadata
try:
    print(metadata.version("hdbscan"))
except metadata.PackageNotFoundError:
    pass
PY
)"
  if [[ -n "$HDBSCAN_VERSION" ]]; then
    echo "Rebuilding hdbscan $HDBSCAN_VERSION for macOS $TARGET compatibility."
    MACOSX_DEPLOYMENT_TARGET="$TARGET" \
      _PYTHON_HOST_PLATFORM="macosx-${TARGET}-${ARCH}" \
      CFLAGS="${CFLAGS:-} -mmacosx-version-min=${TARGET}" \
      LDFLAGS="${LDFLAGS:-} -mmacosx-version-min=${TARGET}" \
      "$VENV_PYTHON" -m pip install --force-reinstall --no-deps --no-cache-dir \
        --no-binary=hdbscan "hdbscan==$HDBSCAN_VERSION"
  fi
fi

"$VENV_PYTHON" - <<'PY'
import senko
print(f"Senko installed: {getattr(senko, '__version__', 'unknown')}")
PY

echo "Senko install complete."
echo "Diarization will use: $VENV_PYTHON"
