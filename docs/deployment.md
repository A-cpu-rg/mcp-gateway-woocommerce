# Deployment and operations guide

Step-by-step procedures for the local k3d cluster and a production-like k3s VPS, plus secrets, backups,
upgrades, rollback and troubleshooting. The architecture and the reasons behind these choices are in
[design.md](design.md); what has actually been verified is in [submission-readiness.md](submission-readiness.md).

> **Status.** The local k3d procedure was run end to end on this project (most recently on 2026-10-26). The
> VPS procedure uses the same charts and Makefile targets, and `values-prod.yaml` renders and passes schema
> validation, but **no VPS deployment has been performed**. Treat the VPS section as a documented, untested
> procedure.

- [1. Components and where they run](#1-components-and-where-they-run)
- [2. Local setup (k3d)](#2-local-setup-k3d)
- [3. Secrets](#3-secrets)
- [4. Production-like setup (VPS with k3s)](#4-production-like-setup-vps-with-k3s)
- [5. Local vs production values](#5-local-vs-production-values)
- [6. Backups](#6-backups)
- [7. Upgrades and rollback](#7-upgrades-and-rollback)
- [8. Troubleshooting](#8-troubleshooting)

## 1. Components and where they run

| Namespace | Helm release (chart) | Workloads |
|---|---|---|
| `platform` | `platform` (`deploy/charts/platform`) | `gateway` (2 replicas; serves dashboard, `/api`, `/mcp`, chat agent), `postgres` (StatefulSet), `toolbox-mcp`, `everything-mcp`, `store-provisioner` |
| `store` | `store` (`deploy/charts/store`) | `wordpress`, `mariadb` (StatefulSet), `woocommerce-mcp`, `store-setup` Job (Helm hook) |
| `store-<slug>` (one per provisioned store) | `store` (same chart), installed by the store-provisioner with `HELM_DRIVER=configmap` | Same as `store` |

Images are built from the single `Dockerfile` (one target per image): `urumi/gateway`, `urumi/woocommerce-mcp`,
`urumi/toolbox-mcp`, `urumi/everything-mcp`, `urumi/store-provisioner`.

## 2. Local setup (k3d)

### Prerequisites

Versions this project was verified with (macOS arm64, 2026-10-26); other recent versions should work.

| Tool | Verified version | Needed for |
|---|---|---|
| Docker Desktop | 29.5.3, VM with 4 GB RAM / 8 CPUs | Images, k3d |
| k3d | 5.9.0 (cluster image `rancher/k3s:v1.33.5-k3s1`, from `deploy/k3d.yaml`) | Local cluster |
| kubectl | 1.36.0 | Everything |
| Helm | 4.3.1 (Helm 3 also works; the provisioner image bundles 3.17.3) | Deploy |
| Node.js | 24.22.0 (`.node-version`: 24) | Tests, `make e2e` |
| pnpm | 10.28.0 (pinned in `package.json`, via corepack) | Install, tests |
| openssl | any | `scripts/create-secrets.sh` |
| kubeconform | 0.8.0 (optional) | `make charts-check` |

Node 23.0–23.7 cannot load `undici@8` (no `zlib.createZstdDecompress`), so the gateway tests fail there; use
Node 24. 4 GB of Docker memory is enough for the platform, the first store and two provisioned stores
(about 70–76 % node memory); give Docker more if you plan to create more stores.

### From a clean checkout

```bash
pnpm install
cp .env.example .env        # optional: Azure OpenAI settings for the chat agent (section 3)
make up                     # cluster + images + import + secrets + deploy-local + status
```

`make up` runs these targets in order (all defined in the `Makefile`):

| Target | What it does |
|---|---|
| `cluster` | `k3d cluster create --config deploy/k3d.yaml` unless cluster `urumi` exists. Maps host ports 80/443 to Traefik |
| `images` | `docker build` of the five Dockerfile targets, tagged `urumi/<name>:dev` (`TAG` overrides) |
| `import` | `k3d image import` of those images (charts use `pullPolicy: Never` locally) |
| `secrets` | `scripts/create-secrets.sh`: creates the namespaces and every Secret (section 3) |
| `deploy-local` | `helm upgrade --install store …` then `platform …` with `values-local.yaml`, `--wait --timeout 10m`, passing `provisioner.apiServerCidr` from the cluster's `kubernetes` EndpointSlice; then restarts the gateway |
| `status` | Lists pods, PVCs and Ingresses, and **prints the dashboard admin email and password** |

The first install takes about 5–8 minutes: the `store-setup` Job installs WordPress, WooCommerce 11.2.1,
Cash on delivery, free shipping and the WooCommerce REST API key.

Expected result: every pod `Running` (the setup Job `Completed`), PVCs `data-postgres-0`, `data-mariadb-0`
and `wordpress-content` `Bound`, Ingresses for `app.localtest.me` and `store.localtest.me`.

### Local domains

`*.localtest.me` is a public DNS name that resolves to `127.0.0.1`, so no `/etc/hosts` changes are needed. k3d
forwards the laptop's ports 80/443 to Traefik inside the cluster, and Traefik routes by host:

| URL | Ingress |
|---|---|
| `http://app.localtest.me` | Dashboard, `/api`, MCP endpoint `/mcp` |
| `http://store.localtest.me` (`/wp-admin` for WooCommerce admin) | The first store |
| `http://<slug>.store.localtest.me` | Each provisioned store |

Offline, or if your DNS resolver refuses answers that point to 127.0.0.1, add to `/etc/hosts`:
`127.0.0.1 app.localtest.me store.localtest.me <slug>.store.localtest.me`.

### Credentials after install

Never paste these into issues or recordings.

```bash
make status                                         # dashboard admin email + password
kubectl -n store get secret store-wp-admin -o jsonpath='{.data.WP_ADMIN_USER}' | base64 -d; echo
kubectl -n store get secret store-wp-admin -o jsonpath='{.data.WP_ADMIN_PASSWORD}' | base64 -d; echo
```

### Checks

```bash
pnpm lint && pnpm typecheck
TEST_DATABASE_URL=postgres://<user>:<password>@localhost:5432/<db> pnpm test   # DB tests skip without it
pnpm build                     # dashboard bundle
make charts-check              # helm lint + render (both charts, both envs) + kubeconform + scripts/chart-checks.sh
make e2e                       # definition-of-done checks against the running cluster (mutates state, see below)
```

`make e2e` (`scripts/e2e.ts`) logs in as the admin, **creates** an API key, a new member user
(`member-<run>@example.com`, cannot be deleted afterwards, only disabled) and a product, **disables and
re-enables** the `toolbox` server and **scales `everything-mcp` to 0** (restored to 1 when the script exits).
It prints 18 `PASS`/`FAIL` lines and `all checks passed` on success.

## 3. Secrets

Charts never contain secret values; they reference Secrets by name. `scripts/create-secrets.sh` (run by
`make secrets`) creates them with random values and **never overwrites an existing Secret** (re-running it does
not rotate anything), except `gateway-llm`, which is re-applied from `.env` on every run.

| Namespace | Secret | Keys | Used by |
|---|---|---|---|
| `store` | `store-db` | `MARIADB_ROOT_PASSWORD`, `MARIADB_PASSWORD` | MariaDB, WordPress, setup Job |
| `store` | `store-wp-admin` | `WP_ADMIN_USER`, `WP_ADMIN_PASSWORD`, `WP_ADMIN_EMAIL` | Setup Job |
| `store` | `store-wc-api` | `WC_CONSUMER_KEY`, `WC_CONSUMER_SECRET` | Setup Job (creates the REST key), woocommerce-mcp |
| `store` | `woocommerce-mcp-auth` | `MCP_AUTH_TOKEN` | woocommerce-mcp (expects it as a bearer token) |
| `platform` | `postgres-auth` | `POSTGRES_PASSWORD` | Postgres, gateway, store-provisioner |
| `platform` | `toolbox-auth` | `TOOLBOX_API_KEY` | toolbox-mcp (expects it in `X-Api-Key`) |
| `platform` | `gateway-secrets` | `ENCRYPTION_KEY` (32 bytes, base64), `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Gateway (bootstrap admin, credential encryption), provisioner |
| `platform` | `gateway-upstreams` | `SEED_SERVERS` (JSON) | Gateway: registers `woocommerce`, `toolbox`, `everything` on first start only; copies the two upstream credentials above |
| `platform` | `gateway-llm` (optional) | `LLM_PROVIDER`, `LLM_ENDPOINT`, `LLM_MODEL`, `LLM_API_VERSION`, `LLM_API_KEY` | Gateway chat agent |

Provisioned stores get the same four store Secrets, created by the store-provisioner with random values.

### LLM provider (chat agent)

Without `LLM_API_KEY` the chat agent is disabled and everything else works.

**Azure OpenAI (what `create-secrets.sh` supports).** Fill `.env` (gitignored; `.env.example` lists the
variables) and re-apply:

```bash
# .env
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/
AZURE_OPENAI_API_KEY=<key>
AZURE_OPENAI_DEPLOYMENT=<chat deployment name>
AZURE_OPENAI_API_VERSION=2024-12-01-preview

make secrets deploy-local     # re-applies gateway-llm; deploy-local restarts the gateway to pick it up
```

**Any OpenAI-compatible API.** The gateway also supports `LLM_PROVIDER=openai` (`POST <endpoint>/chat/completions`
with `Authorization: Bearer`), but `create-secrets.sh` does not write it; create the Secret yourself:

```bash
kubectl -n platform create secret generic gateway-llm --dry-run=client -o yaml \
  --from-literal=LLM_PROVIDER=openai --from-literal=LLM_ENDPOINT=https://<host>/v1 \
  --from-literal=LLM_MODEL=<model> --from-literal=LLM_API_KEY=<key> | kubectl apply -f -
kubectl -n platform rollout restart deploy/gateway
```

Do not run `make secrets` afterwards with an Azure key in `.env`: it would replace this Secret. The gateway's
egress NetworkPolicy only allows public HTTPS (port 443), so a provider on plain HTTP or on a private IP is
not reachable.

## 4. Production-like setup (VPS with k3s)

> Not executed in this project. The commands follow the same Makefile targets as the local setup; the
> differences come from `values-prod.yaml` only.

### 4.1 Server and DNS

- A VPS with at least 2 vCPU / 4 GB RAM (more for several provisioned stores), ports 80 and 443 open.
- DNS A records pointing at the VPS: `app.<domain>`, `store.<domain>`, and a wildcard `*.store.<domain>` for
  provisioned stores.

### 4.2 k3s, Helm and cert-manager

```bash
curl -sfL https://get.k3s.io | sh -              # k3s: Traefik, local-path storage, NetworkPolicy enforcement
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
# Helm 3 or 4: https://helm.sh/docs/intro/install/
helm repo add jetstack https://charts.jetstack.io
helm install cert-manager jetstack/cert-manager -n cert-manager --create-namespace --set crds.enabled=true
kubectl apply -f - <<'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: letsencrypt }
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: <you@example.com>
    privateKeySecretRef: { name: letsencrypt }
    solvers: [{ http01: { ingress: { ingressClassName: traefik } } }]
EOF
```

The prod values reference the issuer by name (`cert-manager.io/cluster-issuer: letsencrypt`) and render a
NetworkPolicy that lets Traefik reach cert-manager's HTTP-01 solver pods.

### 4.3 Images

The charts have no `imagePullSecrets`: push to a **public** registry repository, or configure registry
credentials on the node (`/etc/rancher/k3s/registries.yaml`). Build for the VPS architecture (usually
`linux/amd64`, not the Apple Silicon default), with an immutable version tag:

```bash
REG=ghcr.io/<your-org>; VER=1.0.0
docker buildx build --platform linux/amd64 --target gateway           --build-arg APP=gateway         -t $REG/gateway:$VER           --push .
docker buildx build --platform linux/amd64 --target app               --build-arg APP=woocommerce-mcp -t $REG/woocommerce-mcp:$VER   --push .
docker buildx build --platform linux/amd64 --target app               --build-arg APP=toolbox-mcp     -t $REG/toolbox-mcp:$VER       --push .
docker buildx build --platform linux/amd64 --target everything-mcp                                    -t $REG/everything-mcp:$VER    --push .
docker buildx build --platform linux/amd64 --target store-provisioner --build-arg APP=gateway         -t $REG/store-provisioner:$VER --push .
```

**Edit `deploy/charts/store/values-prod.yaml` before building `store-provisioner`.** That image bundles the
store chart and its values files, and provisioned stores are installed from the bundled
`values-prod.yaml`.

### 4.4 Values

| File | Set |
|---|---|
| `deploy/charts/platform/values-prod.yaml` | `host` (`app.<domain>`), the four image references, `stores.hostTemplate` (`{slug}.store.<domain>`), optionally `storageClass`, `postgres.storage` |
| `deploy/charts/store/values-prod.yaml` | `host` (`store.<domain>`), `woocommerceMcp.image`, optionally `storageClass` and sizes |

`storageClass` and volume sizes cannot be changed after the first install (StatefulSet
`volumeClaimTemplates` are immutable), so choose them first.

### 4.5 Secrets and deploy

On the VPS (or any machine whose kubectl points at it), from a checkout of the repository:

```bash
ADMIN_EMAIL=<you@example.com> make secrets deploy-prod
```

`deploy-prod` reads the API server endpoint from the cluster (on k3s the node IP, port 6443) and passes it as
`provisioner.apiServerCidr`, the store-provisioner's only egress besides Postgres. If that lookup fails, pass
`API_SERVER_IP=<node IP>`.

### 4.6 Verify

```bash
kubectl get pods -A; kubectl get certificate -A          # certificates Ready=True after a minute or two
curl -fsS https://app.<domain>/readyz                       # ok
GATEWAY_URL=https://app.<domain> make e2e                   # mutates state, see section 2
```

## 5. Local vs production values

| Concern | Local (`values-local.yaml`) | VPS (`values-prod.yaml`) |
|---|---|---|
| DNS | `*.localtest.me` → 127.0.0.1 (public DNS) | A records `app.<domain>`, `store.<domain>`, wildcard `*.store.<domain>` |
| Ingress / TLS | Traefik over HTTP, ports mapped by k3d | Traefik with TLS from cert-manager (`ingress.tlsSecret`, issuer annotation) + HTTP-01 solver NetworkPolicy; `stores.urlScheme: https` |
| Cookies | `cookieSecure: false` | `cookieSecure: true` (HTTPS only) |
| Storage | k3d default (`local-path`), 2 Gi per store volume, 1 Gi Postgres | `local-path` (or a cloud block-storage class), 10 Gi per store volume, 5 Gi Postgres, store quota 25 Gi |
| Images | `urumi/*:dev`, built locally, `k3d image import`, `pullPolicy: Never` | Registry images with version tags, `IfNotPresent` |
| Replicas | gateway 2 | gateway 2, woocommerce-mcp 2 |
| Provisioned stores | Installed from the bundled `values-local.yaml` | `provisioner.storeValuesFile: values-prod.yaml` |
| Provisioner egress | API server endpoint only (`provisioner.apiServerCidr`, required; set by `make deploy-local`) | Same (`make deploy-prod`) |
| Secrets | `scripts/create-secrets.sh` | Same script, or Sealed Secrets / External Secrets with the same names |

Templates, NetworkPolicies, probes, resource requests/limits, RBAC and the admission policy are identical.

## 6. Backups

Not automated. The dumps contain password hashes, key hashes and encrypted credentials: store them outside
the repository with restrictive permissions.

```bash
mkdir -p ~/urumi-backups/$(date +%Y%m%d-%H%M%S) && cd "$_" && chmod 700 . && umask 077
kubectl -n platform exec postgres-0 -- pg_dump -U gateway -Fc gateway > gateway.dump
kubectl -n store exec mariadb-0 -- sh -c \
  'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction --routines wordpress' > store.sql
# repeat for each store-<slug> namespace
```

Also keep a copy of the `gateway-secrets` Secret: without `ENCRYPTION_KEY` the stored upstream credentials
cannot be decrypted. Verify a gateway dump by restoring it into a throwaway Postgres
(`pg_restore --no-owner -d <db> gateway.dump`) and comparing row counts.

## 7. Upgrades and rollback

### Upgrade

```bash
# Local: rebuild and redeploy (dev tag)
make images import deploy-local
# Pods whose spec did not change keep the old image under the reused :dev tag; restart them:
kubectl -n platform rollout restart deploy/toolbox-mcp
for ns in store $(kubectl get ns -l urumi.io/store=true -o name | cut -d/ -f2); do
  kubectl -n $ns rollout restart deploy/woocommerce-mcp
done

# VPS: push new version tags, update values-prod.yaml (or --set), then
make deploy-prod
helm history platform -n platform
```

- **Gateway:** rolling update (2 replicas, PodDisruptionBudget `minAvailable: 1`). Migrations are forward-only
  SQL files applied at startup under a Postgres advisory lock; they are additive, so older gateway code keeps
  working against a newer schema.
- **WooCommerce MCP server:** stateless, rolling update.
- **Store:** change `store.woocommerceVersion` or `wordpress.image` and `helm upgrade`; the setup Job converges
  the store again. WordPress/WooCommerce database migrations are not undone by `helm rollback`: back up first.
- **Store-provisioner:** `strategy: Recreate`, so two versions never run at once; leases in Postgres make an
  interrupted store resume on the next pass.

Before an upgrade that changes the store-provisioner's RBAC, follow
[design.md: Provisioner RBAC migration](design.md#provisioner-rbac-migration).

### Rollback

```bash
helm history platform -n platform
helm rollback platform <REVISION> -n platform --wait
```

`helm rollback` restores manifests and values, not image contents. With immutable version tags that is a full
rollback. With the reused local `:dev` tag it is not: before importing new images, keep the running ones
under another tag inside the k3d node, and restore them for a rollback:

```bash
# before the upgrade
for i in gateway store-provisioner toolbox-mcp everything-mcp woocommerce-mcp; do
  docker exec k3d-urumi-server-0 ctr -n k8s.io images tag docker.io/urumi/$i:dev docker.io/urumi/$i:pre-upgrade
done
# to roll back the images
for i in gateway store-provisioner toolbox-mcp everything-mcp woocommerce-mcp; do
  docker exec k3d-urumi-server-0 ctr -n k8s.io images tag --force docker.io/urumi/$i:pre-upgrade docker.io/urumi/$i:dev
done
kubectl -n platform rollout restart deploy/gateway deploy/store-provisioner deploy/toolbox-mcp deploy/everything-mcp
```

Data: database migrations are not rolled back; restore a backup (section 6) if a migration must be undone.
PersistentVolumeClaims are never deleted by `helm upgrade`, `helm rollback` or `helm uninstall` (StatefulSet
volume claims; `wordpress-content` has `helm.sh/resource-policy: keep`).

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `k3d cluster create` fails on port 80/443 | Another process uses the port | Stop it, or change the host ports in `deploy/k3d.yaml` (URLs then need the port) |
| `cannot read the API server endpoint; pass API_SERVER_IP=<ip>` | kubectl points at no cluster, or cannot read EndpointSlices | `kubectl config current-context`; or `make deploy-local API_SERVER_IP=<ip>` |
| Pods `ErrImageNeverPull` | Images not imported into k3d | `make images import` |
| Code change not visible after redeploy | Same `:dev` tag, pod spec unchanged | `kubectl rollout restart` the Deployment (section 7) |
| `app.localtest.me` does not resolve or shows another site | Offline, or the DNS resolver filters 127.0.0.1 answers | `/etc/hosts` entries (section 2) |
| Pods `Pending`, `Insufficient memory` | Docker VM too small for the number of stores | Delete a provisioned store or give Docker more memory |
| PVC `Pending` | No default storage class (non-k3s cluster) | Set `storageClass` in the values before the first install |
| Probes fail and pods restart after the laptop wakes | Host sleep pauses the VM | Pods recover by themselves; disable sleep while demoing |
| Gateway `CrashLoopBackOff`, log `missing env …` or `ENCRYPTION_KEY must be 32 bytes` | Secrets not created | `make secrets`, then `kubectl -n platform rollout restart deploy/gateway` |
| Gateway not Ready, `/readyz` → `database unavailable` | Postgres down or not ready | `kubectl -n platform get pods`, `kubectl -n platform logs postgres-0` |
| Server **Unreachable** in the dashboard | The reason is shown next to it: refused connection, timeout, HTTP 401 (wrong credential) | Check the upstream pod and its credential; for an in-cluster server in a new namespace, add the namespace to `upstreamNamespaces` (gateway egress) |
| Adding a server fails with `url_rejected` | SSRF policy: `http://` only for `*.svc.cluster.local`, no private or metadata addresses, no credentials in URLs | Use `https://` for external servers |
| Server shows `cannot decrypt the stored credential … ENCRYPTION_KEY differs` | `gateway-secrets` was recreated | Restore the old `ENCRYPTION_KEY`, or re-enter the credential in Servers → Edit |
| MCP client gets HTTP 401 | Header must be `Authorization: Bearer mgw_<id>_<secret>`; key revoked, or user disabled | Generate a new key; the response message says `missing`, `malformed`, `unknown`, `revoked` or `user_disabled` |
| A tool is missing for a member, or a call says `requires the admin role` | Admin-only tool (e.g. `woocommerce__create_product`) | Use an admin's key, or own the provisioned store |
| Chat page says chat is disabled / `no LLM configured` | No `gateway-llm` Secret | Section 3, then `make secrets deploy-local` |
| Chat error `LLM provider returned HTTP 401/404` | Wrong key, endpoint or deployment name | Fix `.env` and re-apply |
| Store stuck in **Provisioning** or **Failed** | The reason is shown in the Stores table | `kubectl -n platform logs deploy/store-provisioner`; Failed stores have a **Retry** button |
| store-provisioner log `refusing to start … holds rights it must not have` | Image upgraded without the chart (old RBAC) | `make deploy-local` / `deploy-prod` ([migration](design.md#provisioner-rbac-migration)) |
| `pnpm test` fails with `Cannot read properties of undefined (reading 'bind')` in undici | Node 23.0–23.7 | Use Node 24 |
| Gateway DB tests are skipped | `TEST_DATABASE_URL` not set | Point it at a disposable Postgres database |
