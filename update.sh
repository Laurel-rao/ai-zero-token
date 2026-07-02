#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-root@43.128.120.182}"
REMOTE_SRC="${REMOTE_SRC:-/opt/ai-zero-token/src}"
REMOTE_ENV="${REMOTE_ENV:-/opt/ai-zero-token/.env}"
REMOTE_STATE="${REMOTE_STATE:-/opt/ai-zero-token/state}"
IMAGE_NAME="${IMAGE_NAME:-ai-zero-token:local}"
CONTAINER_NAME="${CONTAINER_NAME:-ai-zero-token}"
HOST_PORT="${HOST_PORT:-80}"
CONTAINER_PORT="${CONTAINER_PORT:-8787}"
DEPLOY_MODE="${DEPLOY_MODE:-docker}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-ai-zero-token}"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$PROJECT_ROOT"

echo "==> Build local project"
npm run build

echo "==> Sync source to ${REMOTE_HOST}:${REMOTE_SRC}"
rsync -az --delete \
  --exclude node_modules \
  ./ "${REMOTE_HOST}:${REMOTE_SRC}/"

if [[ "$DEPLOY_MODE" != "docker" && "$DEPLOY_MODE" != "compose" ]]; then
  echo "DEPLOY_MODE must be docker or compose, got: $DEPLOY_MODE" >&2
  exit 2
fi

echo "==> Build and restart remote Docker deployment (${DEPLOY_MODE})"
ssh "$REMOTE_HOST" bash -s -- \
  "$REMOTE_SRC" \
  "$REMOTE_ENV" \
  "$REMOTE_STATE" \
  "$IMAGE_NAME" \
  "$CONTAINER_NAME" \
  "$HOST_PORT" \
  "$CONTAINER_PORT" \
  "$DEPLOY_MODE" \
  "$COMPOSE_PROJECT_NAME" <<'REMOTE_SCRIPT'
set -euo pipefail

REMOTE_SRC="$1"
REMOTE_ENV="$2"
REMOTE_STATE="$3"
IMAGE_NAME="$4"
CONTAINER_NAME="$5"
HOST_PORT="$6"
CONTAINER_PORT="$7"
DEPLOY_MODE="$8"
COMPOSE_PROJECT_NAME="$9"

cd "$REMOTE_SRC"

if [[ "$DEPLOY_MODE" == "compose" ]]; then
  mkdir -p "$REMOTE_STATE" "$REMOTE_STATE/postgres" "$REMOTE_STATE/redis"
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

  COMPOSE_ARGS=(
    --project-name "$COMPOSE_PROJECT_NAME"
    --env-file "$REMOTE_ENV"
  )
  export IMAGE_NAME
  export CONTAINER_NAME
  export HOST_PORT
  export AI_ZERO_TOKEN_STATE_DIR="$REMOTE_STATE"
  export POSTGRES_DATA_DIR="$REMOTE_STATE/postgres"
  export REDIS_DATA_DIR="$REMOTE_STATE/redis"

  if docker compose version >/dev/null 2>&1; then
    docker compose "${COMPOSE_ARGS[@]}" up -d --build
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "${COMPOSE_ARGS[@]}" up -d --build
  else
    echo "docker compose or docker-compose is required for DEPLOY_MODE=compose" >&2
    exit 2
  fi
else
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
fi

sleep 2
docker ps --filter "name=${CONTAINER_NAME}" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
curl -s --max-time 10 "http://127.0.0.1:${HOST_PORT}/_gateway/auth/status"
echo
REMOTE_SCRIPT

echo "==> Remote deploy done: http://43.128.120.182/"
