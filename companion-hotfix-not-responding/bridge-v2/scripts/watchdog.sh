#!/usr/bin/env bash
set -euo pipefail

env_file="${BRIDGE_V2_ENV_FILE:-/etc/companion/bridge-v2.env}"
url="${BRIDGE_V2_HEALTH_URL:-http://127.0.0.1:3001/healthz}"
api="${BRIDGE_V2_RESTART_URL:-http://127.0.0.1:3001/api/admin/restart-claude}"
log_file="${COMPANION_WATCHDOG_LOG:-/var/log/companion/watchdog.log}"

mkdir -p "$(dirname "$log_file")"

log() {
  printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$log_file"
}

if [[ -f "$env_file" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "$env_file"
  set +a
fi

count_claude() {
  ps -eo pid=,args= \
    | awk '
      /awk/ { next }
      /claude/ && /--dangerously-load-development-channels/ && /companion-channel/ && !/companion-channel\.mjs/ { count++ }
      /claude/ && /--session/ && !/companion-channel\.mjs/ { count++ }
      /tmux -S/ { count-- }
      END { print count + 0 }
    '
}

duplicate_conversation_id() {
  ps -eo pid=,args= \
    | awk '
      /awk/ { next }
      /tmux -S/ { next }
      /companion-channel\.mjs/ { next }
      /claude/ && /--dangerously-load-development-channels/ && /companion-channel/ { print $1 }
      /claude/ && /--session/ { print $1 }
    ' \
    | while read -r pid; do
        cwd="$(readlink "/proc/${pid}/cwd" 2>/dev/null || true)"
        case "$cwd" in
          /var/lib/companion/channel/workdirs/*)
            basename "$cwd"
            ;;
        esac
      done \
    | sort \
    | uniq -c \
    | awk '$1 > 1 { print $2; exit }'
}

if ! curl -fsS --max-time 5 "$url" >/dev/null; then
  log "[watchdog] bridge-v2 health failed, restarting service"
  systemctl restart companion-bridge-v2.service
  exit 0
fi

count="$(count_claude)"
duplicate_conv="$(duplicate_conversation_id)"
if [[ -n "$duplicate_conv" ]]; then
  if [[ -z "${BRIDGE_TOKEN:-}" ]]; then
    log "[watchdog] duplicate Claude conversation=$duplicate_conv count=$count, but BRIDGE_TOKEN is empty; cannot call restart endpoint"
    exit 1
  fi
  log "[watchdog] duplicate Claude conversation=$duplicate_conv count=$count; calling restart endpoint"
  curl -fsS --max-time 90 \
    -X POST \
    -H "Authorization: Bearer ${BRIDGE_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"reason\":\"watchdog_duplicate_processes\",\"conversation_id\":\"${duplicate_conv}\"}" \
    "$api" | tee -a "$log_file" >/dev/null
  printf '\n' >> "$log_file"
  count="$(count_claude)"
fi

log "[watchdog] bridge-v2 healthy; claude_count=$count"
