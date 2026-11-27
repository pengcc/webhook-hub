#!/bin/sh
# Creates the webhook-hub role and database. The Postgres image runs this only
# when the data directory is empty, with POSTGRES_USER and the compose
# environment available. Every project gets its own role and database.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v password="$WEBHOOK_HUB_DB_PASSWORD" <<'SQL'
CREATE ROLE webhook_hub LOGIN PASSWORD :'password';
CREATE DATABASE webhook_hub OWNER webhook_hub;
SQL
