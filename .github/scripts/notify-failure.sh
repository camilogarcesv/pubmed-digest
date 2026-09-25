#!/usr/bin/env bash
# Send a failure notice with the tail of a log to the operator chat. Never fails the job.
# Usage: notify-failure.sh <log-file> <title> <detail-when-the-log-is-empty>
# Needs TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID and RUN_URL. Job logs are public: Telegram's reply,
# which describes the chat, is discarded rather than printed.
set -uo pipefail
if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
  echo "Telegram secrets not configured; skipping failure notification."
  exit 0
fi
DETAIL="$3"
if [[ -s "$1" ]]; then
  # A byte-limited tail can split a character, and Telegram rejects invalid UTF-8: drop the fragment.
  DETAIL=$(tail -c 600 "$1" | iconv -c -f UTF-8 -t UTF-8)
fi
TEXT=$(printf '%s\n\n%s\n\n%s' "$2" "$DETAIL" "$RUN_URL")
curl -sS -f -o /dev/null --connect-timeout 10 --max-time 30 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode chat_id="${TELEGRAM_CHAT_ID}" \
  --data-urlencode text="$TEXT" 2>/dev/null \
  || echo "Could not send the failure notification."
