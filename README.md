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

Requirements: Docker, [k3d](https://k3d.io) ≥ 5.6, kubectl, Helm 3, Node ≥ 22.18, pnpm 10, openssl.

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

## Testing

| What | Command | Needs |
|---|---|---|
| Lint, types | `pnpm lint && pnpm typecheck` | — |
| Unit + integration (real MCP servers, real Postgres) | `TEST_DATABASE_URL=postgres://… pnpm test` | Postgres |
| Charts: lint, render both envs, schema-validate | `make charts-check` | helm, kubeconform |
| Definition of done, two users, incl. revoke / disable / dead upstream | `make e2e` | running cluster |

CI (`.github/workflows/ci.yml`) runs the first three on every push.

## Stand-out items attempted

| Item | Where |
|---|---|
| Tool permissions (per role, hidden **and** rejected) | `apps/gateway/src/broker.ts`, Servers → Edit → admin-only tools |
| Security hardening: SSRF guard (registration + connect time, DNS rebinding), default-deny NetworkPolicies, non-root, credentials encrypted at rest | `apps/gateway/src/url-guard.ts`, `crypto.ts`, `deploy/charts/*/templates/networkpolicy.yaml` |
| Scaling: 2 stateless gateway replicas (no sticky sessions needed) | `apps/gateway/src/mcp.ts`, `deploy/charts/platform/templates/gateway.yaml` |
| Observability: per-call audit with outcome + duration, upstream unreachable reasons | Dashboard → Audit / Servers |
| Upgrades and rollback | [docs/design.md](docs/design.md#upgrades-and-rollback) |
| Production-like VPS | Instructions above; values in `values-prod.yaml` |

Not attempted: multi-store provisioning bonus, OAuth on the gateway, hosted MCP servers by image, metrics endpoint.
