#!/bin/bash
# Keep Freese publish API reachable overnight (localhost.run tunnel).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p incoming

pkill -f 'server/publish.cjs' 2>/dev/null || true
sleep 1
node server/publish.cjs > /tmp/freese-publish-server.log 2>&1 &
echo $! > /tmp/freese-publish-server.pid
sleep 1
curl -fsS http://127.0.0.1:8787/health
echo

pkill -f 'nokey@localhost.run' 2>/dev/null || true
sleep 1
ssh -o StrictHostKeyChecking=accept-new -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -R 80:127.0.0.1:8787 nokey@localhost.run > /tmp/freese-localhost-run.log 2>&1 &
echo $! > /tmp/freese-localhost-run.pid

TUN=""
for i in $(seq 1 15); do
  sleep 2
  TUN=$(rg -o 'https://[a-z0-9]+\.lhr\.life' /tmp/freese-localhost-run.log | head -1 || true)
  if [[ -n "$TUN" ]] && curl -fsS --max-time 10 "$TUN/health" >/dev/null; then
    break
  fi
  TUN=""
done

echo "TUNNEL=${TUN:-failed}"
if [[ -z "$TUN" ]]; then
  echo "tunnel failed; see /tmp/freese-localhost-run.log" >&2
  exit 1
fi

cat > publish-config.js <<EOF
/* Freese Index public publish endpoints (no secrets). Passphrase: traditionology */
window.FREESE_PUBLISH = {
  passphrase: 'traditionology',
  endpoints: [
    '${TUN}/api/publish',
    'http://127.0.0.1:8787/api/publish'
  ]
};
EOF

pkill -f 'caffeinate -dims -w' 2>/dev/null || true
caffeinate -dims -w "$(cat /tmp/freese-publish-server.pid)" >/tmp/freese-caffeinate.log 2>&1 &
echo "publish tunnel ready: $TUN"
