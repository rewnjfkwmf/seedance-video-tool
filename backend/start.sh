#!/usr/bin/env sh
set -eu

PORT="${PORT:-8080}"

exec uvicorn app.main:app \
  --app-dir /app \
  --host 0.0.0.0 \
  --port "${PORT}"
