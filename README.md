# WooCommerce hosting with a Team MCP Gateway

A WooCommerce store on Kubernetes, a WooCommerce MCP server, and a team MCP gateway. An admin registers MCP
servers once; every team member then uses all of them through **one MCP endpoint** (from Claude Code, Cursor,
MCP Inspector) and through a **chat agent** in the dashboard, with their own API key, per-role tool
permissions and an audit log of every call.

```
 Browser / MCP client ──▶ Ingress app.<domain> ──▶ gateway (dashboard + /api + /mcp + chat agent) ──▶ Postgres
                                                       │ per-upstream credential, timeout, audit
                    ┌──────────────────────────────────┼─────────────────────────────┐
                    ▼                                  ▼                             ▼
     woocommerce-mcp (ns store)              toolbox-mcp (ns platform)     everything-mcp (ns platform)
          │ REST API, OAuth1-signed          our 2nd server                 3rd-party reference server
          ▼
 Shopper ─▶ Ingress store.<domain> ─▶ WordPress + WooCommerce ─▶ MariaDB      (all upstreams: ClusterIP only)
```

| Path | What |
|---|---|
| `apps/gateway` | Gateway backend: MCP endpoint, upstream pool, broker (authz, routing, audit), REST API, chat agent |
| `apps/dashboard` | React dashboard (built into the gateway image, served same-origin) |
| `apps/woocommerce-mcp` | Our WooCommerce MCP server (5 tools, Streamable HTTP) |
| `apps/toolbox-mcp` | Second upstream (currency conversion, time, echo) |
| `deploy/charts/store`, `deploy/charts/platform` | Helm charts, with `values-local.yaml` and `values-prod.yaml` |
| `scripts/create-secrets.sh` | Creates every Kubernetes Secret (charts only reference them) |
| `scripts/e2e.ts` | Definition-of-done checks, two users, against any deployment |
| [`docs/design.md`](docs/design.md) | System design, trade-offs, production differences, upgrade/rollback, requirement evidence |
| [`docs/threat-model.md`](docs/threat-model.md) | Threat model |

## Local setup (k3d)

Requirements: Docker, [k3d](https://k3d.io) ≥ 5.6, kubectl, Helm 3 or 4, Node ≥ 22.19 (24 recommended; see `.node-version`), pnpm 10, openssl.

```bash
pnpm install
cp .env.example .env          # optional: Azure OpenAI settings for the chat agent
make up                       # k3d cluster + images + secrets + both Helm releases (5–8 min first time)
make e2e                      # definition-of-done checks (two users), see "Testing" below
```

`make up` prints the URLs and the generated dashboard admin credentials (`make status` prints them again):

- Storefront: <http://store.localtest.me> · WooCommerce admin: <http://store.localtest.me/wp-admin>
- Dashboard: <http://app.localtest.me> · MCP endpoint: `http://app.localtest.me/mcp`

**Local domains:** `*.localtest.me` is a public DNS name that resolves to `127.0.0.1`, so no `/etc/hosts`
edits are needed; k3d maps the laptop's port 80/443 to Traefik inside the cluster. (Offline? Add
`127.0.0.1 store.localtest.me app.localtest.me` to `/etc/hosts`.)

The first install runs a setup Job that installs WordPress and WooCommerce 11.2.1, enables Cash on delivery and
free shipping, and creates the REST API key from the `store-wc-api` Secret. It is idempotent and re-runs on
every `helm upgrade`.

## Production-like setup (VPS with k3s)

Same charts, different values. On a VPS (2 vCPU / 4 GB is enough):

```bash
curl -sfL https://get.k3s.io | sh -                        # k3s: Traefik, local-path storage, NetworkPolicies
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
# TLS (optional, recommended): cert-manager + a ClusterIssuer named "letsencrypt"
helm repo add jetstack https://charts.jetstack.io && helm install cert-manager jetstack/cert-manager \
  -n cert-manager --create-namespace --set crds.enabled=true
kubectl apply -f - <<'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: letsencrypt }
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: you@example.com
    privateKeySecretRef: { name: letsencrypt }
    solvers: [{ http01: { ingress: { ingressClassName: traefik } } }]
EOF
```

1. DNS: point `store.<domain>` and `app.<domain>` (A records) at the VPS.
2. Images: build with the `Dockerfile` targets (see `make images`) and push to a registry, e.g. GHCR.
3. Edit `deploy/charts/*/values-prod.yaml`: `host`, image names, `storageClass`.
4. `ADMIN_EMAIL=you@example.com make secrets deploy-prod`

What changes between local and VPS is listed in [docs/design.md](docs/design.md#local-vs-production).

## Using it

### Place an order (storefront)
Open the storefront, open a product, **Add to cart**, **Checkout**, fill in any address, choose **Cash on
delivery**, **Place order**. The order appears in WooCommerce admin → Orders.

### Team members and API keys
- Admin: **Team → Invite** creates a one-time link (72 h). The member opens it and sets a password.
- Anyone: **Keys → Generate key**. The key is shown once, with ready-made client config. Keys are stored as
  SHA-256 hashes; **Revoke** takes effect on the next request.
- Admin: **Keys → For: <member> → Generate key** issues a key on a member's behalf. It belongs to that member
  (their role, their audit entries), and admins can see and revoke every key with **Show all team keys**.

### Connect an external MCP client
Only the gateway URL and your own key are needed; upstream servers and their credentials are never exposed.

```bash
# Claude Code
claude mcp add --transport http urumi-gateway http://app.localtest.me/mcp \
  --header "Authorization: Bearer mgw_<your key>"
```

```jsonc
// Cursor (~/.cursor/mcp.json) or any client that supports Streamable HTTP + headers
{ "mcpServers": { "urumi-gateway": { "url": "http://app.localtest.me/mcp",
    "headers": { "Authorization": "Bearer mgw_<your key>" } } } }
```

MCP Inspector: `npx @modelcontextprotocol/inspector`, transport *Streamable HTTP*, URL as above, header
`Authorization: Bearer mgw_…`.

Tools appear as `<server>__<tool>`, e.g. `woocommerce__list_orders`, `toolbox__convert_currency`. Try:
*"What orders came in today, and what is their total in EUR?"* (uses two upstream servers).

### Chat agent
Dashboard → **Chat**. It uses the same tools as your key would (filtered by your role), shows every tool call
and its result, and its calls appear in the audit log under your user with channel `chat`. Configure the LLM
in `.env` (Azure OpenAI; any OpenAI-compatible API also works via `LLM_PROVIDER=openai`) and re-run
`make secrets deploy-local`.

### Admin: servers
Dashboard → **Servers**: status (Connected / Unreachable with reason / Disabled), tools per server, add a server
by URL with an optional bearer or custom-header credential, edit, disable, remove, and mark tools admin-only.
The WooCommerce server is pre-registered on first start.

### Stores (multi-store bonus)
Dashboard → **Stores** → name + slug → **Create store**. Any user may create up to 2 stores (`stores.maxPerUser`);
admins see and can delete all of them. A store goes **Provisioning → Ready** in about 3–5 minutes and gets:
namespace `store-<slug>`, its own MariaDB, WordPress volume, Secrets, ResourceQuota and LimitRange,
the storefront at `http://<slug>.store.localtest.me`, and its own WooCommerce MCP server, registered in the
gateway as `store-<slug>` (tools `store-<slug>__list_orders`, …). **Delete** hides its tools at once, then removes
the registration, the Helm release and the namespace (volumes and Secrets with it). A store that cannot be
provisioned within 15 minutes becomes **Failed** with the reason; **Retry** runs the same idempotent steps again.

## Testing

| What | Command | Needs |
|---|---|---|
| Lint, types | `pnpm lint && pnpm typecheck` | — |
| Unit + integration (real MCP servers, real Postgres) | `TEST_DATABASE_URL=postgres://… pnpm test` | Postgres |
| Charts: lint, render both envs, schema-validate | `make charts-check` | helm, kubeconform |
| Definition of done, two users, incl. revoke / disable / dead upstream | `make e2e` | running cluster |

CI (`.github/workflows/ci.yml`) runs the first three on every push.

## Verification status

Verified on local k3d (k3s v1.33.5, Helm 4.3.1 on the laptop and 3.17.3 in the store-provisioner image,
Docker Desktop with 4 GB RAM), 2026-10-22:

| Check | How | Result |
|---|---|---|
| `make up`: images, secrets, both releases, setup Job | `make images import secrets deploy-local` | All pods Ready, 3 PVCs Bound, 2 Ingresses, 11 NetworkPolicies |
| Definition-of-done script, two users | `make e2e` (dead upstream via `kubectl delete pod`) | 18/18, twice in a row |
| Storefront checkout (COD) and WooCommerce admin | Store API cart + checkout; wp-admin → Orders | Order created (`processing`) and listed in admin |
| Chat agent with Azure OpenAI as user A | "Create a product …", then "What orders came in today?" | `create_product` → product page live; `list_orders` returns the order |
| External MCP client as user B | MCP Inspector CLI 0.17.2, gateway URL + B's key only | Tools of all 3 servers, no admin-only tools; orders today; a second server's tool |
| Revoke / disable | Revoke B's key; disable `toolbox` | Next call 401; tools gone from client and chat |
| Audit attribution | Dashboard → Audit | Chat calls under A (`chat`), MCP calls and rejected attempt under B |
| Persistence | Delete `mariadb-0`, `wordpress`, `postgres-0` pods | Products, order, users and keys intact; gateway pods did not restart |
| NetworkPolicies | Probe pods + `exec` from real pods | Only the gateway reaches `woocommerce-mcp`; upstreams have no egress; control request succeeds |
| Helm upgrade and rollback | `helm upgrade … --set …`, `helm rollback platform 1` | Value applied, then restored; data and servers intact |
| Gateway requirements, live | Add/edit/disable/remove a server (header and bearer credentials), `echo` on two servers, a 2 s timeout on a slow tool, credential leak scan of API/MCP/dashboard bundle, member 403s, audit fields | All pass; new servers are listed by both replicas immediately |
| Bonus: multi-store, live | Two stores created at once from the API; provisioner restarted mid-install; cross-store probes; chat "compare today's orders across north and south"; delete one | Both Ready after the restart; isolation holds; chat called `store-north__list_orders` + `store-south__list_orders`; after delete: tools, registration, namespace, both PVs and Secrets gone; a foreign `store-*` namespace makes the store Failed with a reason and is never deleted |
| Workloads and Secrets, live | Live Deployments/StatefulSets; live pod env; `pg_dump` of the gateway DB | Probes and requests/limits on every workload; credentials only via Secrets; no raw API key or upstream credential in Postgres |

Claude Code as the external client was verified on 2026-10-25: connected as a member with only the gateway
URL and that member's key, it listed tools and ran `woocommerce__list_products` + `toolbox__convert_currency`
in one task, both audited to that member.

Not yet verified: a VPS / k3s deployment with TLS (`values-prod.yaml`), Cursor as the client, and the
store-owner permission for admin-only tools (migration `003_server_store.sql`; covered by tests, not yet
deployed to k3d). With 3 stores the 4 GB Docker VM runs at about 70% memory, and host sleep makes probes
time out on wake (pods restart cleanly): disable sleep while recording. Re-run `make up && make e2e` before
recording the video.

## Stand-out items attempted

| Item | Where |
|---|---|
| Tool permissions (per role, hidden **and** rejected) | `apps/gateway/src/broker.ts`, Servers → Edit → admin-only tools |
| Security hardening: SSRF guard (registration + connect time, DNS rebinding), default-deny NetworkPolicies, non-root, credentials encrypted at rest | `apps/gateway/src/url-guard.ts`, `crypto.ts`, `deploy/charts/*/templates/networkpolicy.yaml` |
| Scaling: 2 stateless gateway replicas (no sticky sessions needed) | `apps/gateway/src/mcp.ts`, `deploy/charts/platform/templates/gateway.yaml` |
| Observability: per-call audit with outcome + duration, upstream unreachable reasons | Dashboard → Audit / Servers |
| Upgrades and rollback | [docs/design.md](docs/design.md#upgrades-and-rollback) |
| Production-like VPS | Instructions above; values in `values-prod.yaml` |
| **Bonus: multi-store provisioning** | `apps/gateway/src/{stores,provisioner,kube}.ts`, `deploy/charts/platform/templates/provisioner.yaml`, `deploy/charts/store/templates/guardrails.yaml`, Dashboard → Stores; design in [docs/design.md](docs/design.md#multi-store-provisioning) |

Not attempted: OAuth on the gateway, hosted MCP servers by image, metrics endpoint.
