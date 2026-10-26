# Verification report and submission readiness

What has been verified, how, and what has not. Every result below comes from a command, test run, CI run or
live check that actually took place, with its date; nothing is inferred from configuration alone. Last
updated 2026-10-26.

- [Snapshot](#snapshot)
- [Verdict](#verdict)
- [Status categories and evidence sources](#status-categories-and-evidence-sources)
- [Mandatory requirements](#mandatory-requirements)
- [Definition-of-done flow](#definition-of-done-flow)
- [Bonus and stand-out items](#bonus-and-stand-out-items)
- [Automated checks](#automated-checks)
- [Live k3d verification (2026-10-26)](#live-k3d-verification-2026-10-26)
- [Recorded k3d verification (2026-10-22 and 2026-10-25)](#recorded-k3d-verification-2026-10-22-and-2026-10-25)
- [Not verified](#not-verified)
- [Review findings](#review-findings)
- [Remaining actions](#remaining-actions)
- [Appendix: author's submission checklist and interview preparation](#appendix-authors-submission-checklist-and-interview-preparation)

## Snapshot

| Item | State (2026-10-26) |
|---|---|
| Code under review | `urumi-implementation` at `1c072fc` = `origin/urumi-implementation` |
| `main` | Merge commit `4bbd131` (PR #1 merged 2026-10-26 13:22 UTC); its tree is identical to `1c072fc` |
| CI (GitHub Actions `ci`) | `1c072fc`: 14/14 check runs `success` (push + pull_request: `code`, 5 × `images`, `charts`). `4bbd131` (`main`): 7/7 `success` |
| Deployed on local k3d | The code and charts of `1c072fc`: source in all four built images and the store chart bundled in the provisioner image hash-identical to `1c072fc`; `helm get manifest` of both releases equal to `helm template` of `1c072fc` apart from blank lines and the setup hook |
| Copilot review on PR #1 | Did not run ("insufficient remaining quota"); no automated review comments exist |
| This documentation revision | Changes `README.md` and `docs/*.md` only, not yet committed |

## Verdict

**Ready to submit with disclosed limitations.** Every mandatory requirement is implemented, covered by
automated tests, and was verified on the local k3d cluster: most recently on 2026-10-26 after deploying the
current code, and for the full definition-of-done flow on 2026-10-22 against an earlier build. Disclosed
limitations: no VPS/k3s deployment has been performed; Cursor was not tested as a client; `make e2e` and the
manual storefront/chat flow were not re-run after the 2026-10-26 deployment.

## Status categories and evidence sources

| Status | Meaning |
|---|---|
| **Verified on local k3d (10-26)** | Checked live on the k3d cluster on 2026-10-26, after the current code was deployed, unless marked "before the redeploy" |
| **Verified on local k3d (10-22)** | Recorded by the author on 2026-10-22 (2026-10-25 for Claude Code) against an earlier build; not re-run since |
| **Automated tests passing** | Covered by the repository's tests, which pass locally and in CI |
| **Configuration/chart validated** | Helm lint, render, kubeconform schema validation and `scripts/chart-checks.sh` pass. Not proof of a deployment |
| **Documented but not deployed** | Procedure and values exist; never run |
| **Not implemented** | Absent from the code |
| **Not verified** | Implemented but with no evidence of the behaviour |

## Mandatory requirements

### Kubernetes and Helm

| Requirement | Status | Evidence | Limitations |
|---|---|---|---|
| Runs on local Kubernetes | Verified on local k3d (10-26) | k3d cluster `urumi`, k3s v1.33.5+k3s1; all pods Running after `make images import deploy-local` | Single node, 4 GB Docker VM |
| Deployable to a VPS with the same charts | Configuration/chart validated; Documented but not deployed | `values-prod.yaml` for both charts pass `helm lint`, render and kubeconform (`make charts-check`, CI `charts` job); procedure in [deployment.md](deployment.md#4-production-like-setup-vps-with-k3s) | **No VPS deployment performed**; TLS, DNS and registry images unverified |
| Helm only; local/prod via values files | Configuration/chart validated; Verified on local k3d (10-26) | Two charts, each with `values-local.yaml` / `values-prod.yaml`; no Kustomize; local releases `store` rev 4, `platform` rev 6 | — |
| Store, database, WooCommerce MCP, gateway and dashboard in the cluster | Verified on local k3d (10-26) | Pods: `wordpress`, `mariadb-0`, `woocommerce-mcp` (ns `store`); `gateway` ×2 (serves the dashboard), `postgres-0`, `toolbox-mcp`, `everything-mcp`, `store-provisioner` (ns `platform`) | — |
| Persistent storage for the database and WordPress content | Verified on local k3d (10-26 and 10-22) | 10-26: 7 PVCs Bound; order/product counts identical to pre-deploy dumps after the upgrade (`store` 4/12, `north` 1/1, `south-bang-12` 0/0). 10-22: deleting `mariadb-0`, `wordpress` and `postgres-0` pods kept products, order, users and keys | Node-local `local-path` volumes; no node/disk-loss protection |
| Storefront and dashboard via Ingress with stable URLs; local domain documented | Verified on local k3d (10-26) | `http://store.localtest.me`, `http://north.store.localtest.me`, `http://south-bang-12.store.localtest.me` → 200; `http://app.localtest.me/readyz` → `ok`; `*.localtest.me` approach in [deployment.md](deployment.md#local-domains) | — |
| Readiness and liveness on every workload; requests and limits | Verified on local k3d (10-26); Configuration/chart validated | Live specs inspected (before the redeploy): every Deployment/StatefulSet has both probes and requests/limits, setup Job has requests/limits; deployed manifests equal the `1c072fc` render | Jobs have no probes (not applicable) |
| No hardcoded secrets; credentials in Kubernetes Secrets | Verified (git history, 10-26); Verified on local k3d (10-22) | Scan of all commits: no key patterns, `.env` never committed; charts reference Secrets by name; 10-22: live pod env and `pg_dump` contain no raw credentials | — |

### WooCommerce MCP server

| Requirement | Status | Evidence | Limitations |
|---|---|---|---|
| Written for this project | Source | `apps/woocommerce-mcp` (Hono + MCP TypeScript SDK v2); no WooCommerce MCP plugin installed (setup Job installs only WooCommerce) | — |
| MCP over Streamable HTTP | Automated tests passing; Verified on local k3d (10-26) | `server.test.ts` via `StreamableHTTPClientTransport`; gateway `connected` to every woocommerce-mcp, including a newly provisioned store | — |
| list products, create product, list orders, get order, update order status | Automated tests passing; Verified on local k3d (10-26 and 10-22) | Test "exposes exactly the five required tools", per-tool tests; 10-26: `list_products` on a new store; 10-22: `create_product`, `list_orders` via chat and `make e2e` | `get_order` and `update_order_status` were exercised against WooCommerce 11.2.1 outside Kubernetes during development and in tests, but not recorded on k3d |
| Not reachable from outside; only the gateway can call it | Verified on local k3d (10-26 and 10-22) | ClusterIP, no Ingress (10-26: `store.localtest.me/mcp` → 404; only Traefik is non-ClusterIP); NetworkPolicy admits gateway pods only; bearer token; 10-22: probe pods could not reach it | — |
| Documented how it talks to the store, and why | Documented | [design.md: WooCommerce MCP server](design.md#woocommerce-mcp-server) (REST API, OAuth 1.0a signing); OAuth signature tests | — |

### Gateway

| Requirement | Status | Evidence | Limitations |
|---|---|---|---|
| Admins add, edit, disable, remove servers with an optional header/bearer credential | Automated tests passing; Verified on local k3d (10-22) | `gateway.test.ts` (credential handling, disable, authType none); 10-22: add/edit/disable/remove with header and bearer credentials | Not re-run after the 10-26 deploy |
| One endpoint; listing returns all enabled servers' tools; calls routed correctly | Automated tests passing; Verified on local k3d (10-26) | Test "aggregates tools from every enabled server"; 10-26: `tools/list` on `/mcp` returned 36 tools including `store-rvtmp-1826__*`, and `store-rvtmp-1826__list_products` was routed to that store | — |
| Same tool name on two servers handled by a documented scheme | Automated tests passing; Documented | `<slug>__<tool>`; tests for `shop__echo` / `util__echo` and name sanitizing | — |
| Slow or dead upstream does not break others; timeouts with clear errors | Automated tests passing; Verified on local k3d (10-22) | Tests "slow upstream times out…", "dead upstream…"; 10-22: 2 s timeout on a slow tool, `make e2e` dead-upstream checks | Not re-run after the 10-26 deploy |
| Upstream credentials never sent to browser or client | Automated tests passing; Verified on local k3d (10-22) | Test "upstream credential is used server-side but never returned or stored in plaintext"; 10-22: credential leak scan of API, MCP and dashboard bundle | — |
| At least three upstream servers | Verified on local k3d (10-26) | `woocommerce`, `toolbox`, `everything`, `store-north`, `store-south-bang-12` all `connected` | — |

### Team and access

| Requirement | Status | Evidence | Limitations |
|---|---|---|---|
| Admin and member roles, enforced by the backend | Automated tests passing; Verified on local k3d (10-22) | Tests: member cannot manage servers/invite, admin-only tools hidden and rejected, `store-permissions.test.ts`; 10-22: member 403s | — |
| Per-user API keys, stored hashed, revocable | Automated tests passing; Verified on local k3d (10-22 and 10-26) | Tests: revoked key → 401 on next call, audited; schema test (hashed/encrypted only). 10-22: revoke → next call 401. 10-26 before the redeploy: missing/malformed key → 401 | Revoke-then-reject not re-run after the 10-26 deploy |
| Audit log with user, server, tool, timestamp, duration and outcome, visible in the dashboard | Automated tests passing; Verified on local k3d (10-26 and 10-22) | `audit.test.ts`, audit test in `gateway.test.ts`; 10-26: row `mcp / store-rvtmp-1826 / list_products / 226 ms / ok` with user; 10-22: Dashboard → Audit attribution for both users | — |

### Chat agent

| Requirement | Status | Evidence | Limitations |
|---|---|---|---|
| LLM-driven tool loop through the gateway, showing tool calls | Automated tests passing; Verified on local k3d (10-22) | `agent.test.ts` (scripted model: loop, streamed tool calls/results); Azure adapter unit test; 10-22 with Azure OpenAI; 21 audit rows on channel `chat` present on 10-26 | Not exercised after the 10-26 deploy |
| Acts as the logged-in user; calls in the audit log under that user | Automated tests passing; Verified on local k3d (10-22) | Test "acts as the logged-in user: audit row is attributed to them on the chat channel"; 10-22 audit | — |
| LLM key handled like other secrets | Verified on local k3d (10-26) | `gateway-llm` Secret present (key names inspected, values not); `.env` gitignored | Only Azure is written by `create-secrets.sh`; OpenAI-compatible providers need a manual Secret |

### Deliverables in the repository

| Requirement | Status | Where |
|---|---|---|
| README: local setup, VPS setup, placing an order, external client, chat | Documented | [README.md](../README.md), [deployment.md](deployment.md) |
| Source for dashboard, gateway, WooCommerce MCP server, chat agent | Source | `apps/dashboard`, `apps/gateway`, `apps/woocommerce-mcp`, `apps/gateway/src/agent.ts` |
| Helm charts and local/production values | Configuration/chart validated | `deploy/charts/{store,platform}` |
| System design and trade-offs | Documented | [design.md](design.md) |
| Threat model (shared credentials, no passthrough, untrusted upstreams, member vs member) | Documented | [threat-model.md](threat-model.md) sections 1–4 |
| List of attempted bonus/stand-out items | Documented | [README.md](../README.md#bonus-and-stand-out-items), section below |

## Definition-of-done flow

| Step | Status | Evidence | Limitations |
|---|---|---|---|
| Storefront: add to cart, check out with Cash on delivery; order visible in WooCommerce admin | Verified on local k3d (10-22) | Store API cart + checkout created an order (`processing`), listed in wp-admin → Orders | A manual browser checkout should be shown in the demo |
| Chat as user A: create a product (appears on the storefront); "orders today" returns the hand-placed order | Verified on local k3d (10-22) | Azure OpenAI: `create_product` → product page live; `list_orders` returned the order | Not re-run after the 10-26 deploy |
| External client as user B with only the gateway URL and B's key; tools of every enabled server; orders question | Verified on local k3d (10-22, 10-25) | MCP Inspector CLI 0.17.2 (10-22); Claude Code (10-25). 10-26 before the redeploy: a Claude Code session with a member key listed tools from all five servers and no admin-only tools | Cursor not tested |
| One prompt using two upstream servers | Verified on local k3d (10-22, 10-25) | `woocommerce__list_products` + `toolbox__convert_currency` in one Claude Code task, both audited to the member | — |
| Revoke B's key; next call rejected | Automated tests passing; Verified on local k3d (10-22) | `make e2e`; test | — |
| Disable a server; tools disappear from chat and client | Automated tests passing; Verified on local k3d (10-22) | `make e2e`; test | — |
| Kill one upstream pod; others keep working; dashboard shows it unreachable | Automated tests passing; Verified on local k3d (10-22) | `make e2e` (`kubectl delete pod`, now scale to 0); test | — |
| Every call attributed in the audit log | Automated tests passing; Verified on local k3d (10-22) | Dashboard → Audit: chat calls under A, MCP calls and the rejected attempt under B | — |
| `make e2e` re-run after the 10-26 deploy | **Not run** | It mutates state (creates a user, key and product; toggles `toolbox`; scales `everything-mcp` to 0) | — |

## Bonus and stand-out items

| Item | Status | Evidence | Limitations |
|---|---|---|---|
| Multi-store: create/delete from the dashboard, status, URL, created time | Automated tests passing; Verified on local k3d (10-26) | `stores.test.ts`; 10-26: store created and deleted through `/api/stores` (the dashboard's API): Provisioning → Ready in 76 s, then removed | Driven through the API, not by clicking |
| Several stores provisioned at once | Automated tests passing; Verified on local k3d (10-22) | Concurrency test; 10-22: two stores created at once | — |
| Own namespace, database, Secrets, volumes, Ingress host | Verified on local k3d (10-26) | `store-rvtmp-1826`: MariaDB, WordPress, woocommerce-mcp, 2 PVCs Bound, 4 Secrets, Ingress `rvtmp-1826.store.localtest.me` (200) | — |
| Automatic MCP registration; tool names show the store | Verified on local k3d (10-26) | Server `store-rvtmp-1826` `connected` with 5 tools, listed as `store-rvtmp-1826__*` | — |
| Clean teardown | Verified on local k3d (10-26) | Tools gone immediately; namespace, both PVs, RoleBinding, Helm release, store row and server registration gone in 25 s | — |
| Isolation with NetworkPolicies | Verified on local k3d (10-22); policies present 10-26 | 10-22: cross-store probes; 10-26: 6 policies in the new namespace | Cross-store probes not repeated on 10-26 |
| ResourceQuota, LimitRange, per-user maximum, provisioning timeout | Automated tests passing; Verified on local k3d (10-26) | Quota and LimitRange in every store namespace; tests for the per-user limit and the deadline | Per-user limit and timeout not exercised live |
| Safe retry; recovery after a provisioner restart | Automated tests passing; Verified on local k3d (10-22) | Tests (lease takeover, locked Helm release, deadline → Failed → Retry); 10-22: provisioner restarted mid-install, both stores Ready | — |
| Chat compares today's orders across two stores; deleting one removes its tools and resources | Verified on local k3d (10-22) | Chat called `store-north__list_orders` + `store-south__list_orders`; delete removed tools, registration, namespace, PVs, Secrets | Not re-run after the 10-26 deploy |
| Tool permissions per role (hidden and rejected), store-owner grants | Automated tests passing; Verified on local k3d (10-22) | `gateway.test.ts`, `store-permissions.test.ts` | Store-owner grant tested, not shown live |
| Security hardening: SSRF guard | Automated tests passing | `unit.test.ts`, `gateway.test.ts` | — |
| Security hardening: least-privilege RBAC, admission policy, Pod Security | Verified on local k3d (10-26); Configuration/chart validated | `kubectl auth can-i` and admission dry runs (below); `scripts/chart-checks.sh` | Residual trusted-provisioner risk ([threat model](threat-model.md#6-store-provisioning-the-trusted-provisioner)) |
| Security hardening: default-deny NetworkPolicies, non-root containers, credentials encrypted at rest | Verified on local k3d (10-22); Automated tests passing | Probes, image smoke checks (`user=node`), `pg_dump` scan, crypto tests | WordPress/Apache starts as root |
| Scaling: 2 gateway replicas, no sticky sessions | Automated tests passing; Verified on local k3d (10-26 and 10-22) | `db.test.ts` replica tests; 2/2 replicas serving; 10-22: new servers listed by both replicas immediately | — |
| Rate limits per user or key | Not implemented | Only a per-upstream in-flight limit (32) and the per-user store limit | — |
| Observability: per-call audit (outcome, duration, error), upstream status with reason | Automated tests passing; Verified on local k3d (10-26) | Audit rows; server status `connected` / `unreachable` + reason | No metrics endpoint, dashboards or tracing (**not implemented**) |
| Production-like VPS deployment | Documented but not deployed | [deployment.md](deployment.md#4-production-like-setup-vps-with-k3s), `values-prod.yaml` | Not performed |
| TLS with cert-manager | Configuration/chart validated | Prod renders TLS Ingresses, issuer annotation and the HTTP-01 solver NetworkPolicy (chart check) | Never issued a certificate |
| Upgrades and rollback with Helm | Verified on local k3d (10-26 and 10-22) | 10-26: upgrade `platform` rev 5→6, `store` 3→4 with backups and pinned rollback images; 10-22: `helm upgrade` then `helm rollback platform 1`, data intact | Rollback not exercised on 10-26 |
| OAuth on the gateway | Not implemented | — | API keys and sessions only |
| Hosted MCP servers by container image | Not implemented | — | — |
| Handling many tools (tool search) | Not implemented | The chat agent offers at most 128 tools and truncates the rest | — |

## Automated checks

Run during the review on 2026-10-26 against the code that became `1c072fc` (macOS arm64; Node 24.22.0, pnpm
10.28.0, Postgres 14.20 for the tests, Helm 4.3.1, kubeconform 0.8.0, Docker 29.5.3). CI runs the same
commands on Ubuntu with Postgres 17.

| Command | Scope | Result |
|---|---|---|
| `pnpm lint` | Biome over 61 files | Pass (1 info: Biome config schema migration notice) |
| `pnpm typecheck` | `tsc` for all four apps | Pass |
| `TEST_DATABASE_URL=… pnpm test` | gateway 81 (unit + integration with real Postgres and real MCP servers over Streamable HTTP), woocommerce-mcp 9, toolbox-mcp 3, dashboard 4 | 97/97 pass, 0 skipped |
| `pnpm test` on Node 23.6.0 | Same | Gateway tests fail to load (`undici@8` needs `zlib.createZstdDecompress`, missing before Node 23.8); environment issue, Node 24 required |
| `pnpm build` | Dashboard production bundle | Pass (242 kB JS) |
| `docker build --target …` × 5 + `scripts/image-check.sh` | gateway, woocommerce-mcp, toolbox-mcp, everything-mcp, store-provisioner | 5/5 pass, all run as `node` |
| `make charts-check` | `helm lint` + `helm template` (2 charts × local/prod) + kubeconform 1.33 + 4 security invariants | Pass: 4/4 renders valid, 4/4 invariants |
| Regression test for the Pod Security fix | `stores.test.ts` with the previous vs fixed `provisioner.ts` | 12 pass / 1 fail vs 13/13 |
| GitHub Actions | `1c072fc` and `main` `4bbd131` | 14/14 and 7/7 `success` |

## Live k3d verification (2026-10-26)

The current code was deployed to the existing k3d cluster with the repository's own targets, after
backups, and verified without resetting any data. Times are IST.

| Step | Evidence |
|---|---|
| Pre-checks | Context `k3d-urumi`, node Ready; no store Provisioning or Deleting; node memory 66 % used / 65 % requested; migrations `001`, `002` applied |
| Backup | `pg_dump -Fc` of the gateway database and `mariadb-dump` of all three stores, outside the repository (mode 700/600); gateway dump test-restored into a throwaway Postgres 18 with identical row counts (16 users, 39 keys, 5 servers, 2 stores, 187 audit rows) |
| Migration dry run | `003`, `004` applied to the restored copy: OK; only `store-north` and `store-south-bang-12` linked to their stores |
| Rollback preparation | Running images tagged `urumi/*:pre-review` in the node's containerd; Postgres StatefulSet render identical before and after (no immutable-field change) |
| Deploy (18:15) | `make images import`, `make deploy-local`: `store` rev 4, `platform` rev 6; then `rollout restart` of `toolbox-mcp` and the three `woocommerce-mcp` Deployments (same tag, new image) |
| Health | All gateway, provisioner and MCP pods on the new image IDs, 0 restarts; gateway 2/2, provisioner 1/1 (log `store-provisioner started`, i.e. its least-privilege self-check passed); `/readyz` `ok` |
| Migrations | `schema_migrations`: `001`–`004` |
| Existing stores | Order/product counts identical to the dumps; storefronts 200; all upstreams `connected`; 7 PVCs Bound |
| RBAC (`kubectl auth can-i --as=system:serviceaccount:platform:store-provisioner`) | **no:** get secrets in `platform`; list secrets cluster-wide; create deployments/pods in `kube-system`; create clusterrolebindings; update clusterroles; bind `cluster-admin`; patch/update namespaces; anything in the static `store` namespace; in store namespaces get/list/update/delete of `store-db`/`store-wp-admin`, create serviceaccounts. **yes:** create/delete namespaces; create rolebindings; bind `platform-store-tenant`; in store namespaces create secrets, get `woocommerce-mcp-auth`, create deployments/configmaps |
| Admission policy (server-side dry runs as the provisioner) | **Denied:** namespace `evil`; `store-zz` without store labels, without the Pod Security label, or with `privileged`; RoleBinding in `kube-system`; RoleBinding to another subject; RoleBinding to `cluster-admin` (RBAC escalation check); deleting namespace `store`. **Allowed:** a correctly labelled `store-*` namespace; the tenant role bound to itself in a store namespace |
| Migration of existing stores | RoleBinding `store-provisioner` and label `pod-security.kubernetes.io/enforce=baseline` on `store-north` and `store-south-bang-12` (a server-side dry run first showed no Pod Security violations) |
| Disposable store `rvtmp-1826` (18:26–18:31) | Created via `POST /api/stores` as the admin; Ready in 76 s; namespace labels `urumi.io/store`, `urumi.io/store-id`, `pod-security.kubernetes.io/enforce=baseline`; RoleBinding created by the provisioner; 3 pods Ready, 2 PVCs Bound, Ingress, 6 NetworkPolicies, quota + LimitRange; storefront 200; Helm release stored in a ConfigMap (no Helm Secrets) |
| Registration and call | Gateway server `store-rvtmp-1826` `connected` with 5 tools; `tools/list` on `/mcp` (temporary admin key) included `store-rvtmp-1826__*`; `store-rvtmp-1826__list_products` → `isError=false`, `[]`; audit row `mcp / list_products / ok / 226 ms` |
| Teardown | `DELETE /api/stores/:id` → 200; tools gone from `tools/list` immediately; store row gone after 25 s; namespace, both PVs, RoleBinding, Helm release and server registration gone; other stores unchanged |

Temporary admin API keys created for these calls were revoked by the script. Not run on this date:
`make e2e`, the manual storefront checkout, the chat agent.

Also checked on 2026-10-26 **before** the redeploy (earlier build): `/mcp` without a key or with a malformed
key → 401; `/api/servers` without a session → 401; a form-encoded POST → 400 (CSRF guard); dashboard served
with CSP, `frame-ancestors 'none'` and `nosniff`.

## Recorded k3d verification (2026-10-22 and 2026-10-25)

Recorded by the author in the README (commit `a961974`, 2026-10-23) against the build deployed at that time
(k3s v1.33.5, Helm 4.3.1 on the laptop and 3.17.3 in the store-provisioner image, Docker Desktop with 4 GB
RAM). Not re-run during this review.

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
| Gateway requirements | Add/edit/disable/remove a server (header and bearer credentials), `echo` on two servers, a 2 s timeout on a slow tool, credential leak scan of API/MCP/dashboard bundle, member 403s, audit fields | All pass; new servers are listed by both replicas immediately |
| Multi-store | Two stores created at once from the API; provisioner restarted mid-install; cross-store probes; chat "compare today's orders across north and south"; delete one | Both Ready after the restart; isolation holds; chat called `store-north__list_orders` + `store-south__list_orders`; after delete: tools, registration, namespace, both PVs and Secrets gone; a foreign `store-*` namespace makes the store Failed with a reason and is never deleted |
| Workloads and Secrets | Live Deployments/StatefulSets; live pod env; `pg_dump` of the gateway DB | Probes and requests/limits on every workload; credentials only via Secrets; no raw API key or upstream credential in Postgres |
| Claude Code as external client (2026-10-25) | Member key + gateway URL only | Listed tools; ran `woocommerce__list_products` + `toolbox__convert_currency` in one task, both audited to that member |

## Not verified

- **VPS / k3s deployment**, TLS certificate issuance, registry images, production DNS: documented and
  rendered only.
- **Cursor** as an MCP client.
- After the 2026-10-26 deployment: `make e2e`, manual storefront checkout, chat agent, revoke-then-reject,
  disable, killed upstream, cross-store chat comparison. These were verified on 2026-10-22 against an earlier
  build and are covered by automated tests.
- `get_order` and `update_order_status` on k3d (tests and development runs against WooCommerce only).
- Helm rollback after the 2026-10-26 upgrade (prepared, not exercised).

## Review findings

From the independent review on 2026-10-26. Copilot did not review PR #1 (quota), so there were no automated
review comments to triage.

| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | High (demo/security) | The k3d cluster ran a build that predated the least-privilege provisioner RBAC: its ClusterRole granted Secrets and workload rights in every namespace; migrations `003`/`004` were missing | **Resolved:** deployed and verified on 2026-10-26 |
| F2 | Medium (security) | Store namespaces had no Pod Security enforcement, so a stolen provisioner token could start a privileged/hostPath pod in a store namespace and reach the node; the threat model claimed "outside store namespaces: nothing" | **Fixed in `1c072fc` and deployed:** `baseline` label on new store namespaces, required by the admission policy; regression test and chart invariant; existing store namespaces labelled |
| F3 | Medium (evidence) | No VPS/k3s deployment performed | Open, disclosed |
| F4 | Low | Non-UUID ids in `PUT/DELETE /api/servers/:id` and `PATCH /api/users/:id` return 500 `internal` (Postgres 22P02) instead of 404 | Open, accepted (no data exposure) |
| F5 | Low | Members' `GET /api/servers` includes the last connection error, which can contain internal hostnames | Open, accepted |
| F6 | Low | No login rate limiting or lockout | Open, disclosed |
| F7 | Low | SSRF block list omits some special-purpose ranges (198.18.0.0/15, 192.0.0.0/24, 6to4 `2002::/16`); the egress NetworkPolicy still blocks private ranges and 169.254.0.0/16 | Open, disclosed |
| F8 | Low | `engines: node >=22.19` admits Node 23.0–23.7, where `undici@8` fails to load | Open; documented (use Node 24) |
| F9 | Low | `list_orders created_on` uses an exclusive `before=<day>T23:59:59`, missing an order placed in the last second of the day | Open, accepted |
| F10 | Low (docs) | Stale or inaccurate documentation (`--set` in a diagram, migration verification command, OpenAI-compatible LLM setup, read-only root filesystem claim) | Fixed in the documentation |
| F11 | Info | `make status` and `scripts/create-secrets.sh` print the dashboard and WordPress admin passwords | Documented; keep them off recordings |

## Remaining actions

1. Review and commit this documentation revision; push and confirm CI.
2. Optional, recommended before recording: `make e2e` on the current deployment (mutates state; see
   [deployment.md](deployment.md#checks)).
3. Record the demo on the current deployment: browser checkout with Cash on delivery, chat as user A, external
   client as user B with a two-server prompt, revoke / disable / kill a pod, audit log, cross-store comparison
   and store deletion. Disable host sleep.
4. Optional: a VPS deployment ([deployment.md](deployment.md#4-production-like-setup-vps-with-k3s)) would move
   F3 from documented to verified.

## Appendix: author's submission checklist and interview preparation

Preparation notes for the author; not part of the technical evidence.

**Checklist**

- [x] Latest commit pushed; CI green (`1c072fc`, `main` `4bbd131`)
- [x] PR #1 merged into `main`
- [x] Repository public; the assessment brief excluded from Git (`.gitignore`)
- [x] Current code deployed to k3d and verified (2026-10-26)
- [ ] This documentation revision committed and pushed; CI green
- [ ] Demo video recorded (two users, definition-of-done flow, Kubernetes, MCP internals, security, chat, local → VPS story)
- [ ] Video link opens in a private window
- [ ] Submission form sent with the video and repository links before the deadline

**Likely interview questions**

- *Architecture:* Why does the chat agent call the broker in-process rather than `/mcp` with a minted key? Why
  does the gateway serve the dashboard? Why Postgres as the provisioner's desired-state store instead of a CRD?
- *MCP routing:* Walk through a `tools/call` from Claude Code to MariaDB and back. How does `<slug>__<tool>`
  stay unambiguous? How do two stateless replicas serve one client, and how does a replica learn about a server
  added through the other?
- *Kubernetes:* What is public and what is internal-only, and which object enforces each? Why does the
  woocommerce-mcp readiness probe not check the store? What exactly can the store-provisioner do, and what stops
  it from touching `kube-system`?
- *Security:* What can a member do with an upstream credential they never see? Why no token passthrough? What
  can a malicious MCP server's descriptions or results do? How are DNS rebinding and `::ffff:169.254.169.254`
  handled?
- *Failure and recovery:* An upstream hangs mid-`create_product`: what does the client see, what does the audit
  log say, why no retry? The provisioner dies during `helm upgrade`: what happens? The audit insert fails: is
  the tool still called?
- *Trade-offs:* What changes for hundreds of tools? What would you fix next?
