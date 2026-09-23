#!/usr/bin/env bash
# Stops the local stack and removes its volumes, so the next demo-up.sh starts
# from an empty database rather than from the last run's executions.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

docker compose --project-directory "$ROOT/infra" down -v

if [[ -f "$ROOT/.mock.pid" ]]; then
  kill "$(cat "$ROOT/.mock.pid")" 2>/dev/null || true
  rm -f "$ROOT/.mock.pid" "$ROOT/.mock.log"
fi
echo "stopped"
