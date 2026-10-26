#!/usr/bin/env bash
# Security invariants of the rendered charts (run by `make charts-check`, so CI catches regressions).
# Needs only helm, awk and grep.
set -euo pipefail
cd "$(dirname "$0")/.."

CIDR=(--set provisioner.apiServerCidr=10.0.0.1/32)
fail() { echo "FAIL  $*"; exit 1; }
pass() { echo "PASS  $*"; }
render() { helm template "$1" "deploy/charts/$1" -n "$1" -f "deploy/charts/$1/values-$2.yaml" "${@:3}"; }
# Prints the rendered document of the given kind and name.
doc() { awk -v kind="kind: $1" -v name="  name: $2" '
  /^---/ { if (k && n) print buf; buf = ""; k = 0; n = 0; next }
  { buf = buf $0 "\n"; if ($0 == kind) k = 1; if ($0 == name) n = 1 }
  END { if (k && n) print buf }'; }

# cert-manager HTTP-01 solver pods must be reachable through the ingress controller when TLS is on, and the
# policy must not exist without TLS.
for c in store platform; do
  render "$c" prod "${CIDR[@]}" | doc NetworkPolicy acme-http01-solver | grep -q 'acme.cert-manager.io/http01-solver' \
    || fail "$c prod: no NetworkPolicy admits the cert-manager HTTP-01 solver"
  if render "$c" local "${CIDR[@]}" | grep -q 'acme-http01-solver'; then fail "$c local: solver policy without TLS"; fi
done
pass "ACME HTTP-01 solver policy exactly when TLS is configured"

# The provisioner's API-server egress has no default and is never open to the internet.
if render platform local >/dev/null 2>&1; then fail "platform renders without provisioner.apiServerCidr"; fi
policy=$(render platform prod "${CIDR[@]}" | doc NetworkPolicy store-provisioner)
grep -q 'cidr: "10.0.0.1/32"' <<<"$policy" || fail "provisioner egress does not use apiServerCidr"
if grep -q '0.0.0.0/0' <<<"$policy"; then fail "provisioner egress is open to 0.0.0.0/0"; fi
pass "provisioner API-server egress is required and narrow"

# Least-privilege RBAC: the cluster-wide role grants no Secrets or workloads, and the tenant role (which does)
# is never bound cluster-wide.
all=$(render platform prod "${CIDR[@]}")
cluster=$(doc ClusterRole platform-store-provisioner <<<"$all")
[ -n "$cluster" ] || fail "provisioner ClusterRole not rendered"
if grep -Eq 'secrets|deployments|statefulsets|jobs|pods|configmaps' <<<"$cluster"; then
  fail "cluster-wide provisioner role grants Secrets or workloads"
fi
if doc ClusterRoleBinding platform-store-provisioner <<<"$all" | grep -q 'store-tenant'; then
  fail "tenant role is bound cluster-wide"
fi
doc ValidatingAdmissionPolicy platform-store-provisioner <<<"$all" | grep -q "startsWith('store-')" \
  || fail "admission policy restricting the provisioner to store-* is missing"
pass "provisioner RBAC: no cluster-wide Secrets/workloads, tenant role bound per namespace, admission policy"
