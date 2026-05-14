#!/usr/bin/env bash

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TAURI_CONF="$ROOT_DIR/src-tauri/tauri.conf.json"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script only supports macOS."
  exit 1
fi

if ! command -v tccutil >/dev/null 2>&1; then
  echo "Missing required command: tccutil"
  exit 1
fi

DRY_RUN=0
INCLUDE_LOCAL_BUILDS=0
VERBOSE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --include-local-builds)
      INCLUDE_LOCAL_BUILDS=1
      shift
      ;;
    --verbose)
      VERBOSE=1
      shift
      ;;
    -h|--help)
      cat <<'EOF'
Usage: ./scripts/reset-breeze-macos.sh [options]

Options:
  --dry-run                Print planned actions without changing anything.
  --include-local-builds   Also remove local build output app bundles in target/.
  --verbose                Print full command output while running.
  -h, --help               Show this help.
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

say() {
  echo "$@"
}

run_cmd() {
  if [[ $DRY_RUN -eq 1 ]]; then
    say "DRY-RUN: $*"
    return 0
  fi

  if [[ $VERBOSE -eq 1 ]]; then
    "$@"
  else
    "$@" >/dev/null 2>&1
  fi
}

run_or_warn() {
  if ! run_cmd "$@"; then
    say "WARN: command failed: $*"
    return 1
  fi
  return 0
}

remove_path() {
  local path="$1"

  if [[ ! -e "$path" ]]; then
    return 0
  fi

  say "Removing: $path"
  if run_cmd rm -rf "$path"; then
    return 0
  fi

  if [[ "$path" == /Applications/* ]]; then
    say "Retrying with sudo: $path"
    run_or_warn sudo rm -rf "$path"
    return 0
  fi

  say "WARN: failed to remove $path"
  return 1
}

extract_identifier_from_tauri_conf() {
  if [[ ! -f "$TAURI_CONF" ]]; then
    echo "com.pais.breeze.dev"
    return 0
  fi

  local id
  id="$(sed -n 's/.*"identifier":[[:space:]]*"\([^"]*\)".*/\1/p' "$TAURI_CONF" | head -n 1)"
  if [[ -n "$id" ]]; then
    echo "$id"
  else
    echo "com.pais.breeze.dev"
  fi
}

collect_bundle_ids() {
  local default_id
  default_id="$(extract_identifier_from_tauri_conf)"

  # Keep this list explicit to clear older installs too.
  local ids=(
    "$default_id"
    "com.pais.breeze"
    "com.pais.breeze.dev"
  )

  # Include any ids discoverable from installed app bundles.
  local app
  for app in "/Applications/BreezeType.app" "$HOME/Applications/BreezeType.app"; do
    if [[ -d "$app" ]]; then
      local plist="$app/Contents/Info.plist"
      if [[ -f "$plist" ]]; then
        local maybe_id
        maybe_id="$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$plist" 2>/dev/null || true)"
        if [[ -n "$maybe_id" ]]; then
          ids+=("$maybe_id")
        fi
      fi
    fi
  done

  printf '%s\n' "${ids[@]}" | awk 'NF && !seen[$0]++'
}

collect_tcc_clients() {
  local bundle_ids=("$@")
  local clients=()

  local id
  for id in "${bundle_ids[@]}"; do
    clients+=("$id")
  done

  # Path-based client identifiers can exist for local dev binaries.
  local possible_bins=(
    "$ROOT_DIR/src-tauri/target/debug/breeze"
    "$ROOT_DIR/src-tauri/target/release/breeze"
  )

  local bin
  for bin in "${possible_bins[@]}"; do
    if [[ -e "$bin" ]]; then
      clients+=("$bin")
    fi
  done

  printf '%s\n' "${clients[@]}" | awk 'NF && !seen[$0]++'
}

reset_tcc_for_client() {
  local client="$1"
  local services=("All" "Accessibility" "Microphone" "ScreenCapture" "ListenEvent")

  local service
  for service in "${services[@]}"; do
    if [[ $DRY_RUN -eq 1 ]]; then
      say "DRY-RUN: tccutil reset $service $client"
      continue
    fi

    local output
    output="$(tccutil reset "$service" "$client" 2>&1 || true)"
    if [[ "$output" == *"Successfully reset"* ]]; then
      say "TCC reset ok: service=$service client=$client"
      if [[ $VERBOSE -eq 1 ]]; then
        printf '%s\n' "$output"
      fi
    else
      say "TCC reset note: service=$service client=$client"
      if [[ $VERBOSE -eq 1 ]]; then
        printf '%s\n' "$output"
      fi
    fi
  done
}

say "BreezeType macOS reset starting..."

say "1) Quitting BreezeType processes"
run_or_warn osascript -e 'tell application "BreezeType" to quit'
run_or_warn pkill -x BreezeType
run_or_warn pkill -x breeze
sleep 1

say "2) Removing installed app bundles"
remove_path "/Applications/BreezeType.app"
remove_path "$HOME/Applications/BreezeType.app"

if [[ $INCLUDE_LOCAL_BUILDS -eq 1 ]]; then
  say "Including local build artifacts"
  remove_path "$ROOT_DIR/src-tauri/target/release/bundle/macos/BreezeType.app"
  remove_path "$ROOT_DIR/src-tauri/target/debug/bundle/macos/BreezeType.app"
fi

say "3) Removing autostart launch agents"
remove_path "$HOME/Library/LaunchAgents/BreezeType.plist"
remove_path "$HOME/Library/LaunchAgents/com.pais.breeze.dev.plist"
remove_path "$HOME/Library/LaunchAgents/com.pais.breeze.plist"

say "4) Removing BreezeType app data/cache/logs"
remove_path "$HOME/Library/Application Support/com.pais.breeze.dev"
remove_path "$HOME/Library/Application Support/com.pais.breeze"
remove_path "$HOME/Library/Application Support/BreezeType"
remove_path "$HOME/Library/Logs/com.pais.breeze.dev"
remove_path "$HOME/Library/Logs/com.pais.breeze"
remove_path "$HOME/Library/Caches/com.pais.breeze.dev"
remove_path "$HOME/Library/Caches/com.pais.breeze"
remove_path "$HOME/Library/Caches/breeze"
remove_path "$HOME/Library/Preferences/com.pais.breeze.dev.plist"
remove_path "$HOME/Library/Preferences/com.pais.breeze.plist"
remove_path "$HOME/Library/HTTPStorages/com.pais.breeze.dev"
remove_path "$HOME/Library/HTTPStorages/com.pais.breeze"
remove_path "$HOME/Library/WebKit/com.pais.breeze.dev"
remove_path "$HOME/Library/WebKit/com.pais.breeze"
remove_path "$HOME/Library/Saved Application State/com.pais.breeze.dev.savedState"
remove_path "$HOME/Library/Saved Application State/com.pais.breeze.savedState"

say "5) Resetting TCC permissions"
mapfile -t BUNDLE_IDS < <(collect_bundle_ids)
mapfile -t TCC_CLIENTS < <(collect_tcc_clients "${BUNDLE_IDS[@]}")

for client in "${TCC_CLIENTS[@]}"; do
  reset_tcc_for_client "$client"
done

say
say "Reset complete."
say "Next steps:"
say "1. Reinstall BreezeType (or run it via your usual dev/build flow)."
say "2. Launch BreezeType and confirm the permissions gate appears immediately."
say "3. Click Allow for Microphone and Accessibility (native prompts / direct Settings links)."
say "4. Optional: allow Input Monitoring + Screen Recording for Fn-key PTT and Meetings system audio."

