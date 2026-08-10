#!/bin/bash
# Watchdog: keep Freese publish server + localhost.run tunnel alive overnight.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG=/tmp/freese-publish-watchdog.log
cd "$ROOT"

while true; do
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) watchdog tick" >>"$LOG"
  if ! curl -fsS --max-time 3 http://127.0.0.1:8787/health >/dev/null 2>&1; then
    pkill -f 'server/publish.cjs' 2>/dev/null || true
    sleep 1
    nohup node server/publish.cjs >>/tmp/freese-publish-server.log 2>&1 &
    echo $! >/tmp/freese-publish-server.pid
    sleep 1
  fi
  TUN=$(rg -o 'https://[a-z0-9]+\.lhr\.life' publish-config.js 2>/dev/null | head -1 || true)
  HEALTHY=0
  if [[ -n "${TUN:-}" ]] && curl -fsS --max-time 8 "$TUN/health" >/dev/null 2>&1; then
    HEALTHY=1
  fi
  if [[ "$HEALTHY" -ne 1 ]]; then
    pkill -f 'nokey@localhost.run' 2>/dev/null || true
    sleep 1
    nohup ssh -o StrictHostKeyChecking=accept-new -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
      -R 80:127.0.0.1:8787 nokey@localhost.run >>/tmp/freese-localhost-run.log 2>&1 &
    echo $! >/tmp/freese-localhost-run.pid
    NEW=""
    for i in $(seq 1 20); do
      sleep 2
      NEW=$(rg -o 'https://[a-z0-9]+\.lhr\.life' /tmp/freese-localhost-run.log | tail -1 || true)
      if [[ -n "$NEW" ]] && curl -fsS --max-time 8 "$NEW/health" >/dev/null 2>&1; then
        break
      fi
      NEW=""
    done
    if [[ -n "$NEW" ]]; then
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) new tunnel $NEW" >>"$LOG"
      cat > publish-config.js <<EOF
/* Freese Index public publish endpoints (no secrets). Passphrase: traditionology */
window.FREESE_PUBLISH = {
  passphrase: 'traditionology',
  endpoints: [
    '${NEW}/api/publish',
    'http://127.0.0.1:8787/api/publish'
  ]
};
EOF
      # Best-effort push so live site tracks the tunnel (may fail if dirty/locked)
      if git diff --quiet publish-config.js 2>/dev/null; then
        :
      else
        git add publish-config.js >/dev/null 2>&1 || true
        git commit -m "chore: refresh overnight publish tunnel URL" >/dev/null 2>&1 || true
        git push origin master >/dev/null 2>&1 || true
      fi
    else
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) tunnel refresh failed" >>"$LOG"
    fi
  fi
  caffeinate -dims -t 120 >/dev/null 2>&1 || true
done
