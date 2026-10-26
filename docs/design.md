# System design and trade-offs

## Components

| Component | Runs as | Responsibility |
|---|---|---|
| WordPress + WooCommerce | Deployment (1, `Recreate`) + PVC, ns `store` | The store. Public via Ingress `store.<domain>` |
| MariaDB | StatefulSet + PVC, ns `store` | Store database. Reachable only by WordPress and the setup Job |
| Store setup Job | Helm post-install/upgrade hook | Idempotently installs WordPress + WooCommerce, COD, free shipping, and the REST API key from a Secret |
| woocommerce-mcp | Deployment, ClusterIP, ns `store` | Our MCP server: `list_products`, `create_product`, `list_orders`, `get_order`, `update_order_status` |
| gateway | Deployment (2 replicas), ns `platform` | MCP endpoint, upstream pool, broker, REST API, chat agent, serves the dashboard |
| Postgres | StatefulSet + PVC, ns `platform` | Users, keys, sessions, invites, server registry, audit log |
| toolbox-mcp | Deployment, ClusterIP | Our second upstream: `convert_currency`, `current_time`, `echo` |
| everything-mcp | Deployment, ClusterIP | Third-party reference server (`@modelcontextprotocol/server-everything`), treated as untrusted |

Everything that must scale, fail or be secured independently is its own workload; everything else is a
module inside the gateway. The dashboard is a static bundle served by the gateway (same origin: no CORS,
`SameSite=Strict` cookies work), and the chat agent is a module of the gateway (see ADR 4).

### Gateway modules (`apps/gateway/src`)

| File | Responsibility |
|---|---|
| `mcp.ts` | The single MCP endpoint. Authenticates the gateway API key, then serves `tools/list` / `tools/call` from the broker |
| `broker.ts` | **Single enforcement point** for the MCP endpoint and the chat agent: resolve name → server, check role/enabled, call, audit |
| `upstreams.ts` | One MCP client per upstream per replica, tool cache, health checks, timeouts, in-flight limit |
| `url-guard.ts` | SSRF policy at registration and at socket-connect time |
| `servers.ts` | Admin CRUD for upstreams; credentials encrypted, write-only |
| `auth.ts`, `crypto.ts` | Users, invites, sessions, API keys (hashed), scrypt passwords, AES-256-GCM |
| `agent.ts` | Chat tool loop; provider adapter for Azure OpenAI / OpenAI-compatible APIs |
| `api.ts`, `app.ts`, `db.ts` | REST API, wiring, Postgres pool + forward-only migrations under an advisory lock |

## A tool call, end to end

```
Claude Code ──POST /mcp  tools/call woocommerce__list_orders  (Authorization: Bearer mgw_<id>_<secret>)──▶ Traefik ──▶ gateway pod
 mcp.ts      look up key by id, compare SHA-256(secret) in constant time, check not revoked + user enabled
             (one indexed query per request, no cache: revocation is immediate)
 broker.ts   "woocommerce__list_orders" → slug "woocommerce" (prefix before "__"; slugs cannot contain "_")
             → server row from Postgres (fresh: enabled? admin-only tools?) → cached tool "list_orders"
             → member calling an admin-only tool, and not the owner of the server's store? reject
               (mayUseTool: the same check hides it from tools/list and the dashboard)
 upstreams   reuse the pooled MCP client for that server (Streamable HTTP, credential decrypted in memory,
             socket address checked by the SSRF guard), AbortSignal with the server's timeout
woocommerce-mcp  bearer check → zod validation → GET http://wordpress.store.svc/wp-json/wc/v3/orders?after=…
             signed with OAuth 1.0a (consumer key from its own Secret) → WordPress → MariaDB
 broker.ts   result size cap (512 KB), audit row {user, key, channel, server, tool, duration, outcome}
◀── result to Claude Code
```

The chat agent calls `broker.callTool(sessionUser, 'chat', …)`, the same function, so permissions, timeouts and
audit are identical; the model is only offered tools that user may call.

## Tool aggregation, naming and routing

- **Listing.** `tools/list` is answered from each replica's in-memory tool cache, filtered by the server table
  (read fresh from Postgres on every request) and by role. It never waits on an upstream, so a slow or dead
  server cannot slow down listing. Each replica refreshes every upstream in parallel every 10 s
  (`Promise.allSettled`, 5 s cap each), and immediately after an admin edit.
- **Collision scheme.** Exposed name = `<slug>__<tool>`. Slugs are unique and match `[a-z0-9-]{1,24}`, so the
  `__` separator is unambiguous (`shop__echo` vs `util__echo`). Names that are longer than 64 characters or use
  characters LLM APIs reject (`^[a-zA-Z0-9_-]{1,64}$`) are sanitized and given an 8-hex hash of the original
  name, so they stay unique. Descriptions are prefixed with `[Server name]` and capped at 1024 characters.
- **Routing.** By lookup (slug → server row → cached tool → original name), never by forwarding the name blindly.
- **Protocol versions.** MCP TypeScript SDK v2 serves the 2026-07-28 protocol (stateless) and 2025-era clients
  (initialize handshake) on the same endpoint, without sessions. The upstream client negotiates (`auto`) and
  falls back to the 2025 protocol, which is what `server-everything` speaks.

## Failure handling

| Situation | Behaviour |
|---|---|
| Upstream slow | Per-server timeout (default 10 s, configurable) → tool error *"did not answer within N ms. The outcome is unknown; check the current state before retrying a write."* Other servers are unaffected (separate clients, separate in-flight limit of 32) |
| Upstream dead / pod killed | Health check marks it `unreachable` with the reason (`ECONNREFUSED`, timeout, HTTP 401…), its tools leave the list, direct calls get a clear error. The client is discarded and reconnected on the next check |
| Upstream returns a JSON-RPC error | Reported as a tool error; the connection is kept (the server is alive) |
| Retries | **None for `tools/call`**: tools have side effects (`create_product`), so retrying after a timeout could duplicate. Listing/health checks repeat naturally |
| Huge result | Dropped above 512 KB with an explanation; chat agent truncates tool output to 12 K chars |
| Gateway readiness | Depends only on Postgres. A dead upstream never takes the gateway out of the Service |
| Disabled server | Checked from Postgres on every list and call, so it takes effect immediately on every replica |

## Persistence

| Data | Where | Survives |
|---|---|---|
| Store database (products, orders) | MariaDB StatefulSet, PVC `data-mariadb-0` (`volumeClaimTemplates`) | Pod restart, `helm upgrade`, `helm uninstall` (StatefulSet PVCs are never deleted by Helm) |
| WordPress content (uploads, plugins, `wp-config.php`) | PVC `wordpress-content`, `helm.sh/resource-policy: keep` | Same |
| Gateway data (users, key hashes, encrypted upstream credentials, audit log) | Postgres StatefulSet, PVC `data-postgres-0` | Same |

- Both databases are single-replica on one `ReadWriteOnce` volume. A pod restart reattaches the same volume
  and the database recovers from its log (the DB probes have a startup probe of up to 10 minutes so crash
  recovery is not killed). **Not guaranteed:** node or disk loss. `local-path` volumes live on the node's
  disk; use a replicated storage class or back up (below) if that matters.
- Database passwords are read only when a database is first initialised (`MARIADB_*`, `POSTGRES_PASSWORD`).
  `scripts/create-secrets.sh` never overwrites a Secret, so re-running it cannot lock the app out of its own
  data; rotating those passwords later needs `ALTER USER` as well as the Secret.
- `ENCRYPTION_KEY` lives only in the `gateway-secrets` Secret, never in the database. Losing it makes stored
  upstream credentials unreadable; the dashboard then shows *"ENCRYPTION_KEY differs from the one it was saved
  with"* for those servers. Back it up with the other Secrets.
- `storageClass` and volume size are fixed once a StatefulSet exists (Kubernetes forbids editing
  `volumeClaimTemplates`); choose them before the first install in a new environment.
- Postgres major versions are not interchangeable on an existing volume: `pg_dump` / restore to upgrade.
- Gateway: migrations are forward-only SQL files applied at startup inside a transaction, under
  `pg_advisory_lock`, so replicas starting together cannot race. At startup the gateway waits (up to 2 minutes)
  for Postgres, and a dropped connection (Postgres restart) is logged and re-established instead of crashing.
  Forward-only + additive changes keep `helm rollback` of the gateway safe (old code ignores new columns).
- Readiness of the gateway depends on Postgres only. The WooCommerce MCP pod is ready when it is alive: the
  store is installed by a post-install Job, and Helm starts post-install hooks only after `--wait` sees every
  workload Ready, so a readiness probe that needed the store would deadlock the first install.

Backups (not automated; run before upgrades):

```bash
kubectl -n store exec mariadb-0 -- sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction wordpress' > store.sql
kubectl -n platform exec postgres-0 -- pg_dump -U gateway gateway > gateway.sql
```

Check persistence on a cluster (run on k3d; see the README's verification table):

```bash
kubectl -n store exec mariadb-0 -- sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" wordpress -e "select count(*) from wp_posts"'
kubectl -n store delete pod mariadb-0 && kubectl -n store wait --for=condition=Ready pod/mariadb-0 --timeout=5m
# run the same count again: it must be unchanged; also open the storefront and the orders list
kubectl -n platform delete pod postgres-0 && kubectl -n platform rollout status deploy/gateway   # keys, servers, audit still there
```

## Multi-store provisioning

The pattern is a controller reconciling desired state, as Kubernetes operators do, but with Postgres as the
store of desired state and the existing store chart as the unit of deployment.

```
Dashboard ─▶ gateway /api/stores ─▶ Postgres: stores (desired state, status, reason, deadline, lease)
                                         ▲
store-provisioner (own ServiceAccount) ──┘ claims work (FOR UPDATE SKIP LOCKED + 90 s lease, renewed)
   ├─ namespace store-<slug>  (labels urumi.io/store=true, urumi.io/store-id=<id>)
   ├─ Secrets (create if missing, never overwritten)
   ├─ helm upgrade --install store deploy/charts/store -n store-<slug> --set host=<slug>.store.<domain> --wait
   └─ registers gateway server store-<slug> (bearer token encrypted)  ─▶ gateway health check ─▶ Ready
```

| Concern | How |
|---|---|
| Who has cluster credentials | Only the store-provisioner (no Service, no Ingress, NetworkPolicy allows no ingress). The internet-facing gateway has none; it only writes rows. RBAC: namespaces + the kinds the store chart creates. It must be a ClusterRole because namespaces are created at runtime; the code also refuses any namespace outside `store-*` and never deletes a namespace it did not label with the store's id |
| Several at once | Concurrency 3 per provisioner; each store is leased individually |
| Safe to retry | Create with the same slug returns the existing store; every step is create-if-missing or `helm upgrade --install` |
| Provisioner restarts mid-way | Its lease expires and the next provisioner re-runs the steps; a Helm release left `pending-*` is uninstalled first (volumes are kept) |
| Fails cleanly | Transient errors are retried with backoff and shown as the reason; past the deadline (15 min) the store is **Failed** with the step and error. **Retry** gives a new deadline |
| Not reachable except by the gateway | Unchanged store chart NetworkPolicies; the gateway's egress admits any namespace labelled `urumi.io/store=true`. The provisioner does not call store MCP servers either: it waits for the gateway's health check to report the server connected |
| Isolation | Each store's MCP server reaches only its own WordPress; its WordPress only its own MariaDB (verified with probes across stores) |
| Guardrails | ResourceQuota + LimitRange in every store namespace, 2 stores per user (checked under a per-user advisory lock), 15 min deadline |
| Teardown | Server disabled immediately (tools gone for every client), then registration deleted, `helm uninstall`, namespace deleted (PVCs, Secrets, Ingress), row removed once the namespace is gone |

Limits: one provisioner replica is enough (leases make more safe, not faster); store owners do not get the
WordPress admin password in the dashboard (it is in the store's `store-wp-admin` Secret).

## Architecture decisions

| # | Decision | Alternatives | Why |
|---|---|---|---|
| 1 | TypeScript on Node 24, run with built-in type stripping; pnpm workspace | Go, Python; tsc build step | Best-supported MCP SDK; dashboard shares the language; no build step or bundler for services |
| 2 | MCP SDK v2, stateless HTTP | SDK v1 with sessions | Multiple gateway replicas need no sticky sessions or shared session store; one endpoint still serves 2025 clients |
| 3 | Broker as the single enforcement point | Checks in each endpoint | Authorization, routing and audit cannot drift between the MCP endpoint and the chat agent |
| 4 | Chat agent calls the broker in-process as the session user | Agent calls its own `/mcp` with a minted key | Same enforcement code path, no extra hop or token to manage; the `/mcp` endpoint is only an adapter over the broker |
| 5 | WooCommerce via REST API, OAuth 1.0a signing | WP-CLI via `kubectl exec`; Basic auth | REST is the supported interface and needs no Kubernetes API access. WooCommerce only accepts Basic auth over HTTPS; the in-cluster hop is HTTP, so we sign requests (verified against WooCommerce 11.2.1) |
| 6 | Two charts (`store`, `platform`) in separate namespaces | One umbrella chart | Shows what runs where; the store chart is exactly the unit a multi-store provisioner would install per namespace |
| 7 | Secrets created outside Helm (`scripts/create-secrets.sh`), charts reference names | Helm-generated secrets via `lookup` | Secrets never appear in values files or Helm release history; same mechanism locally and on the VPS (swap for Sealed Secrets / External Secrets later) |
| 8 | Gateway serves the dashboard bundle | Separate nginx Deployment | One fewer image; same origin removes CORS and simplifies CSRF |
| 9 | Postgres via `pg` + SQL migrations | ORM | ~6 tables; an ORM would add more than it saves |
| 10 | k3d locally | kind, minikube | Same distribution as k3s on the VPS: Traefik, local-path storage and NetworkPolicy enforcement match |
| 11 | Server config read from Postgres on each call; tool definitions cached per replica | Shared cache (Redis) | Disable/permission changes are immediate on all replicas without another component; tool lists change rarely |

## Local vs production

| Concern | Local (`values-local.yaml`) | VPS (`values-prod.yaml`) |
|---|---|---|
| DNS | `*.localtest.me` → 127.0.0.1 (public DNS) | Real A records for `store.<domain>`, `app.<domain>` |
| Ingress | Traefik (k3d), HTTP, ports mapped by k3d | Traefik (k3s), TLS via cert-manager (`tlsSecret`, issuer annotation) |
| Cookies | `COOKIE_SECURE=false` | `cookieSecure: true` |
| Storage | `local-path` (k3d default) | `local-path` on the VPS disk, or a cloud block-storage class; larger sizes |
| Images | Built locally, `k3d image import`, `pullPolicy: Never` | Pushed to a registry with version tags |
| Secrets | `scripts/create-secrets.sh` (random values, LLM key from `.env`) | Same script on the VPS, or Sealed Secrets / External Secrets |
| Replicas | gateway 2 | gateway 2, woocommerce-mcp 2 |

Nothing else differs: templates, NetworkPolicies, probes and limits are identical.

## Upgrades and rollback

```bash
# Upgrade one component: build/push a new tag, then
helm upgrade platform deploy/charts/platform -n platform -f deploy/charts/platform/values-prod.yaml \
  --set gateway.image=ghcr.io/your-org/gateway:1.1.0 --wait
helm history platform -n platform
helm rollback platform <REVISION> -n platform --wait    # previous images and manifests
```

- **Gateway**: rolling update (2 replicas, PDB `minAvailable: 1`), no downtime; stateless MCP means clients
  are unaffected. Migrations are additive, so rolling back the code is safe; never ship a destructive migration
  in the same release as the code that stops using a column.
- **WooCommerce MCP server**: stateless, rolling update / rollback like the gateway.
- **Store**: change `store.woocommerceVersion` or `wordpress.image` and `helm upgrade`; the setup Job converges.
  WordPress/WooCommerce run DB migrations on upgrade that `helm rollback` does not undo, so back up first:
  `kubectl -n store exec mariadb-0 -- sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" wordpress' > backup.sql`
  plus a copy of the `wordpress-content` volume. Roll back the image together with restoring that backup.

## Requirement evidence

"Tests" = automated tests in this repo (CI). "Local run" = verified in development against real processes
(real WordPress 7.1.3 + WooCommerce 11.2.1 + MariaDB, real MCP servers, real Postgres) without Kubernetes.
"Cluster" = covered by `make e2e` / manual demo on k3d or k3s.

| Requirement | Evidence |
|---|---|
| 5 WooCommerce tools over Streamable HTTP | Tests `woocommerce-mcp/test/server.test.ts`; local run against WooCommerce 11.2.1 (create, list, get, update status) |
| Storefront checkout with COD | Local run: setup script + Chromium checkout, order visible via `list_orders`; cluster |
| MCP server unreachable from outside, only gateway can call | ClusterIP + no Ingress + NetworkPolicy `woocommerce-mcp` + bearer token (tested: wrong token → 401); cluster |
| One endpoint, all enabled servers, routing | Tests `gateway.test.ts` (aggregation, collisions, legacy clients); local run `scripts/e2e.ts` |
| Same tool name on two servers | Tests: `shop__echo` / `util__echo`; naming unit tests |
| Slow / dead upstream isolated, timeouts, clear error | Tests (slow, dead); local run with a real killed process; cluster `make e2e` (scale to 0) |
| Upstream credentials never sent to browser or client | Tests: API response and DB ciphertext checks |
| Add / edit / disable / remove servers | Tests; dashboard |
| Admin and member roles; hidden + rejected tools | Tests (list and direct call); local run |
| Own API keys, hashed, revocable | Tests (revoked → 401 on next call, audited); local run |
| Audit log with user, server, tool, time, duration, outcome | Tests; local run (screenshot of audit page) |
| Chat agent tool loop, acts as user, shows tool calls | Tests with a scripted model (loop, audit attribution, tool filtering); Azure adapter unit test; cluster with Azure OpenAI (audit rows with channel `chat` under the session user) |
| Helm, local + prod values, probes, limits, Secrets, PVCs, Ingress | `make charts-check` (lint + kubeconform, both envs); workload policy check; cluster |
| Runs on k3d and k3s | Cluster: `make up && make e2e` |
