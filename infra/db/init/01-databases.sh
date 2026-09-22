#!/bin/bash
# Runs once, on the first boot of an empty postgres volume.
#
# Two databases live in this one server:
#   $POSTGRES_DB  - n8n's own tables (workflows, executions, credentials)
#   $ECOM_OPS_DB  - the application tables in sql/schema.sql that the
#                   workflows read and write
#
# Keeping them apart means n8n's database can be dropped and rebuilt without
# losing the audit trail, and a dump of the audit trail stays small enough to
# restore in seconds.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "CREATE DATABASE \"${ECOM_OPS_DB}\";"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "${ECOM_OPS_DB}" \
  -f /schema/schema.sql

echo "created ${ECOM_OPS_DB} and applied sql/schema.sql"
