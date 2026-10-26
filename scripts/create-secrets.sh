#!/usr/bin/env bash
# Creates every Kubernetes Secret the charts reference. Secrets live outside Helm values and release
# history; charts only reference them by name. Idempotent: an existing Secret is never overwritten
# (re-running does not rotate credentials), except gateway-llm, which is refreshed from .env.
#
#   STORE_NS=store PLATFORM_NS=platform ADMIN_EMAIL=you@example.com scripts/create-secrets.sh
#
# Reads LLM settings from .env (gitignored) if present: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY,
# AZURE_OPENAI_DEPLOYMENT, AZURE_OPENAI_API_VERSION.
set -euo pipefail

STORE_NS="${STORE_NS:-store}"
PLATFORM_NS="${PLATFORM_NS:-platform}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

rand() { openssl rand -hex "${1:-24}"; }
exists() { kubectl -n "$1" get secret "$2" >/dev/null 2>&1; }
get() { kubectl -n "$1" get secret "$2" -o "jsonpath={.data.$3}" | base64 -d; }
create() { # create <ns> <name> --from-literal=...
  local ns="$1" name="$2"; shift 2
  if exists "$ns" "$name"; then echo "secret $ns/$name exists, kept"; return; fi
  kubectl -n "$ns" create secret generic "$name" "$@" >/dev/null && echo "secret $ns/$name created"
}

kubectl create namespace "$STORE_NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl create namespace "$PLATFORM_NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

# ---- store namespace ----
create "$STORE_NS" store-db --from-literal=MARIADB_ROOT_PASSWORD="$(rand)" --from-literal=MARIADB_PASSWORD="$(rand)"
WP_ADMIN_PASSWORD="$(rand 12)"
create "$STORE_NS" store-wp-admin --from-literal=WP_ADMIN_USER=admin \
  --from-literal=WP_ADMIN_PASSWORD="$WP_ADMIN_PASSWORD" --from-literal=WP_ADMIN_EMAIL="$ADMIN_EMAIL"
create "$STORE_NS" store-wc-api --from-literal=WC_CONSUMER_KEY="ck_$(rand 20)" --from-literal=WC_CONSUMER_SECRET="cs_$(rand 20)"
create "$STORE_NS" woocommerce-mcp-auth --from-literal=MCP_AUTH_TOKEN="$(rand 32)"

# ---- platform namespace ----
create "$PLATFORM_NS" postgres-auth --from-literal=POSTGRES_PASSWORD="$(rand)"
create "$PLATFORM_NS" toolbox-auth --from-literal=TOOLBOX_API_KEY="$(rand 32)"
GATEWAY_ADMIN_PASSWORD="$(rand 12)"
create "$PLATFORM_NS" gateway-secrets --from-literal=ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  --from-literal=ADMIN_EMAIL="$ADMIN_EMAIL" --from-literal=ADMIN_PASSWORD="$GATEWAY_ADMIN_PASSWORD"

# The gateway's first-start registrations, including the upstream credentials it needs. The values are
# copied from the upstreams' own Secrets; members and MCP clients never see them.
if ! exists "$PLATFORM_NS" gateway-upstreams; then
  WOO_TOKEN="$(get "$STORE_NS" woocommerce-mcp-auth MCP_AUTH_TOKEN)"
  TOOLBOX_KEY="$(get "$PLATFORM_NS" toolbox-auth TOOLBOX_API_KEY)"
  SEED=$(cat <<JSON
[
  {"slug":"woocommerce","name":"WooCommerce store","url":"http://woocommerce-mcp.${STORE_NS}.svc.cluster.local:8080/mcp",
   "authType":"bearer","credential":"${WOO_TOKEN}","adminOnlyTools":["create_product","update_order_status"]},
  {"slug":"toolbox","name":"Toolbox","url":"http://toolbox-mcp.${PLATFORM_NS}.svc.cluster.local:8080/mcp",
   "authType":"header","authHeader":"X-Api-Key","credential":"${TOOLBOX_KEY}"},
  {"slug":"everything","name":"Everything (reference server)","url":"http://everything-mcp.${PLATFORM_NS}.svc.cluster.local:8080/mcp",
   "adminOnlyTools":["get-env"]}
]
JSON
)
  create "$PLATFORM_NS" gateway-upstreams --from-literal=SEED_SERVERS="$SEED"
fi

# LLM key: refreshed from .env on every run so a newly added key takes effect.
if [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi
if [ -n "${AZURE_OPENAI_API_KEY:-}" ]; then
  kubectl -n "$PLATFORM_NS" create secret generic gateway-llm \
    --from-literal=LLM_PROVIDER=azure \
    --from-literal=LLM_ENDPOINT="${AZURE_OPENAI_ENDPOINT:?}" \
    --from-literal=LLM_MODEL="${AZURE_OPENAI_DEPLOYMENT:?}" \
    --from-literal=LLM_API_VERSION="${AZURE_OPENAI_API_VERSION:-2024-12-01-preview}" \
    --from-literal=LLM_API_KEY="$AZURE_OPENAI_API_KEY" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  echo "secret $PLATFORM_NS/gateway-llm applied from .env"
else
  echo "no AZURE_OPENAI_API_KEY in .env: chat agent will be disabled (everything else works)"
fi

echo
echo "Dashboard admin: $(get "$PLATFORM_NS" gateway-secrets ADMIN_EMAIL) / $(get "$PLATFORM_NS" gateway-secrets ADMIN_PASSWORD)"
echo "WordPress admin: $(get "$STORE_NS" store-wp-admin WP_ADMIN_USER) / $(get "$STORE_NS" store-wp-admin WP_ADMIN_PASSWORD)"
