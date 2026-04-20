#!/usr/bin/env bash
# Ruft GET /api/health mit dem PORT aus .env im Projektroot auf (Fallback 3000).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ -f .env ]]; then
  # shellcheck disable=SC2046
  PORT=$(grep -E '^[[:space:]]*PORT=' .env | tail -1 | cut -d= -f2- | tr -d '\r' | tr -d '[:space:]')
fi
PORT="${PORT:-3000}"
exec curl -sS "http://127.0.0.1:${PORT}/api/health"
