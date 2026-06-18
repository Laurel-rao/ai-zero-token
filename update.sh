#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-root@43.134.21.160}"
REMOTE_SRC="${REMOTE_SRC:-/opt/ai-zero-token/src}"
REMOTE_ENV="${REMOTE_ENV:-/opt/ai-zero-token/.env}"
REMOTE_STATE="${REMOTE_STATE:-/opt/ai-zero-token/state}"
IMAGE_NAME="${IMAGE_NAME:-ai-zero-token:local}"
CONTAINER_NAME="${CONTAINER_NAME:-ai-zero-token}"
HOST_PORT="${HOST_PORT:-80}"
CONTAINER_PORT="${CONTAINER_PORT:-8787}"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$PROJECT_ROOT"

echo "==> Build local project"
npm run build

echo "==> Sync source to ${REMOTE_HOST}:${REMOTE_SRC}"
rsync -az --delete \
  --exclude node_modules \
  ./ "${REMOTE_HOST}:${REMOTE_SRC}/"

echo "==> Build and restart remote Docker container"
ssh "$REMOTE_HOST" bash -s -- \
  "$REMOTE_SRC" \
  "$REMOTE_ENV" \
  "$REMOTE_STATE" \
  "$IMAGE_NAME" \
  "$CONTAINER_NAME" \
  "$HOST_PORT" \
  "$CONTAINER_PORT" <<'REMOTE_SCRIPT'
set -euo pipefail

REMOTE_SRC="$1"
REMOTE_ENV="$2"
REMOTE_STATE="$3"
IMAGE_NAME="$4"
CONTAINER_NAME="$5"
HOST_PORT="$6"
CONTAINER_PORT="$7"

cd "$REMOTE_SRC"

docker build -t "$IMAGE_NAME" . >/tmp/azt-build.log
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --env-file "$REMOTE_ENV" \
  -e AI_ZERO_TOKEN_HOME=/data \
  -p "${HOST_PORT}:${CONTAINER_PORT}" \
  -v "${REMOTE_STATE}:/data" \
  "$IMAGE_NAME"

sleep 2
docker ps --filter "name=${CONTAINER_NAME}" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
curl -s --max-time 10 "http://127.0.0.1:${HOST_PORT}/_gateway/auth/status"
echo
REMOTE_SCRIPT

echo "==> Remote deploy done: http://43.134.21.160/"
