#!/bin/sh
# Creates macmini-run/.env (mode 600) for docker-compose.yml without printing any value:
# copies only the platform variables the gateway needs from ../.env and generates a
# random MCP_SERVER_TOKEN. Never overwrites an existing macmini-run/.env.
set -eu
cd "$(dirname "$0")"
[ -f .env ] && { echo ".env already exists; leaving it untouched."; exit 0; }
[ -f ../.env ] || { echo "../.env not found" >&2; exit 1; }
umask 077
{
  for name in META_ACCESS_TOKEN GOOGLE_PROJECT_ID GOOGLE_APPLICATION_CREDENTIALS GOOGLE_ADS_LOGIN_CUSTOMER_ID; do
    grep -E "^${name}=" ../.env || true
  done
  echo "MCP_SERVER_TOKEN=$(openssl rand -hex 32)"
  echo "MCP_ALLOWED_HOSTS=localhost,127.0.0.1,[::1],social-media-mcp-gateway"
} > .env
echo "Created macmini-run/.env (values not shown)."
