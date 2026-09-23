#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Brings up the local stack - n8n, Postgres and the mock WooCommerce/LLM/Slack
# server - imports the four workflow files with the n8n CLI, and attaches
# credentials so the workflows can be executed for real.
#
#   scripts/demo-up.sh
#
# Then: node test/run-scenarios.mjs   (or drive the webhooks by hand)
# Tear down with: scripts/demo-down.sh
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/infra/.env"

[[ -f "$ENV_FILE" ]] || { echo "infra/.env is missing - copy infra/.env.example to infra/.env first"; exit 1; }

# Only the keys the scripts need. infra/.env holds values with spaces in them
# (STORE_NAME), which docker compose parses fine but `.` would choke on.
read_env() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }
export POSTGRES_USER="$(read_env POSTGRES_USER)"
export POSTGRES_PASSWORD="$(read_env POSTGRES_PASSWORD)"
export ECOM_OPS_DB="$(read_env ECOM_OPS_DB)"
export N8N_HOST_PORT="$(read_env N8N_HOST_PORT)"
MOCK_PORT="${MOCK_PORT:-5799}"

echo "==> starting postgres and n8n"
docker compose --project-directory "$ROOT/infra" up -d

echo "==> starting the mock WooCommerce / LLM / Slack server on :$MOCK_PORT"
if curl -sf "http://127.0.0.1:$MOCK_PORT/__control/calls" >/dev/null 2>&1; then
  echo "    already running"
else
  PORT="$MOCK_PORT" nohup node "$ROOT/test/mocks/server.mjs" >"$ROOT/.mock.log" 2>&1 &
  echo $! >"$ROOT/.mock.pid"
fi

echo "==> waiting for n8n on http://127.0.0.1:$N8N_HOST_PORT"
for _ in $(seq 1 90); do
  if curl -sf "http://127.0.0.1:$N8N_HOST_PORT/healthz" >/dev/null; then break; fi
  sleep 2
done
curl -sf "http://127.0.0.1:$N8N_HOST_PORT/healthz" >/dev/null || { echo "n8n did not become healthy"; exit 1; }

echo "==> importing workflows/ with the n8n CLI"
docker compose --project-directory "$ROOT/infra" exec -T n8n \
  n8n import:workflow --separate --input=/workflows

echo "==> creating credentials, setting the error workflow, activating"
node "$ROOT/scripts/configure-n8n.mjs"

echo
echo "n8n editor : http://localhost:$N8N_HOST_PORT  (demo@localhost.test / DemoRun-2026!x)"
echo "mock server: http://localhost:$MOCK_PORT/__control/calls"
echo "postgres   : docker compose --project-directory infra exec postgres psql -U $POSTGRES_USER -d $ECOM_OPS_DB"
