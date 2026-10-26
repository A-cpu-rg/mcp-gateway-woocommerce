#!/usr/bin/env bash
# Smoke-checks a built image: the files its workload needs are in it (catches .dockerignore / COPY mistakes).
#   scripts/image-check.sh <image> <gateway|woocommerce-mcp|toolbox-mcp|everything-mcp|store-provisioner>
set -euo pipefail
image=$1 kind=$2
run() { docker run --rm --entrypoint sh "$image" -c "$1"; }
case "$kind" in
  gateway)
    run 'test -f /app/src/main.ts && test -f /app/dashboard/index.html && ls /app/dashboard/assets/*.js >/dev/null' ;;
  woocommerce-mcp | toolbox-mcp)
    run 'test -f /app/src/main.ts && test -d /app/node_modules/@modelcontextprotocol/server' ;;
  everything-mcp)
    run 'test -f /app/node_modules/@modelcontextprotocol/server-everything/dist/index.js && test -x /sbin/tini' ;;
  store-provisioner)
    # The provisioner installs stores from this chart and runs as non-root with the bundled Helm.
    run 'test -f /app/src/provisioner-main.ts && test -f /app/charts/store/Chart.yaml \
      && test -f /app/charts/store/values-local.yaml && test -f /app/charts/store/values-prod.yaml \
      && test -f /app/charts/store/templates/networkpolicy.yaml && test -f /app/charts/store/files/bootstrap.sh \
      && helm version --short >/dev/null && helm template store /app/charts/store >/dev/null' ;;
  *) echo "unknown image kind $kind"; exit 2 ;;
esac
user=$(docker image inspect "$image" --format '{{.Config.User}}')
[ "$kind" = everything-mcp ] || [ "$user" = node ] || { echo "FAIL $image runs as '$user', expected node"; exit 1; }
echo "PASS  $kind image: required files present, user=${user:-root}"
