# Submission readiness review

Review date: 2026-10-26 (deadline 2026-10-26 23:59 IST). Branch `urumi-implementation`, reviewed at
`e5c1d1a` (in sync with `origin`), PR #1 → `main`. AI-assisted independent review; every result below comes
from a command run during this review unless it is marked as earlier evidence.

## Verdict

**READY WITH DISCLOSED LIMITATIONS**, with one step that must happen before the demo is recorded.

- The code, charts and docs at HEAD meet every mandatory requirement on the evidence available: 97/97
  automated tests (real Postgres, real MCP servers over Streamable HTTP), lint, typecheck, dashboard build,
  5/5 image builds with smoke checks, `make charts-check` (both charts × both environments, schema-valid,
  security invariants), and green CI on the pushed HEAD.
- **Blocking before recording (P0):** the live k3d cluster runs a build from 2026-10-22/23 that predates the
  last three commits. Today's provisioner RBAC rework, the admission policy and migrations `003`/`004` were
  never deployed, and the running provisioner still holds the **old cluster-wide rights over Secrets and
  workloads**. Redeploy HEAD and re-run `make e2e` (commands under "Remaining actions") so the video shows the
  code being submitted.
- Disclosed limitations: no VPS/k3s deployment has been performed (values-prod is rendered and validated
  only), Cursor was not tested as a client, and the bonus teardown has not been exercised on HEAD's RBAC.

> **Update, 2026-10-26 18:30 IST: P0 done.** HEAD plus this review's changes were deployed to k3d and
> verified live; see "Live k3d deployment verification" below. `make e2e` was not re-run (it mutates state),
> so the revoke / disable / kill-pod and chat steps still rest on the 2026-10-22 run plus the test suite.

## Evidence levels

| Tag | Meaning |
|---|---|
| **T** | Automated test, run in this review (Node 24.22.0, Postgres 14) |
| **S** | Static check run in this review (lint, typecheck, Helm lint/render, kubeconform, chart invariants, image smoke) |
| **L** | Live k3d cluster, read-only inspection in this review. **The cluster runs a pre-HEAD build** |
| **E** | Earlier evidence recorded in the README (2026-10-22 / 10-25), not re-run in this review |
| **NV** | Not verified |

## Requirement matrix (mandatory)

### Kubernetes and Helm

| Requirement | Files | Evidence | Result | Remaining action |
|---|---|---|---|---|
| Runs on local Kubernetes | `deploy/k3d.yaml`, `Makefile` | L: k3d `urumi`, k3s v1.33.5, all pods Running in `platform`, `store`, `store-north`, `store-south-bang-12` | PASS (pre-HEAD build) | P0 redeploy |
| Deployable to VPS with the same charts | `deploy/charts/*/values-prod.yaml`, README | S: `helm lint` + `helm template` + kubeconform for prod values; never deployed | PARTIAL | Disclose (P2: deploy if time) |
| Helm only; local/prod via values | `deploy/charts/{store,platform}` | S: 4 renders (2 charts × 2 envs) valid | PASS | — |
| Store, DB, MCP, gateway, dashboard in cluster | charts | L: WordPress, MariaDB, woocommerce-mcp, gateway (serves dashboard), Postgres pods | PASS | — |
| Persistent storage for DB and WP content | `mariadb.yaml`, `wordpress.yaml`, `postgres.yaml` | L: 7 PVCs Bound (`data-mariadb-0`, `wordpress-content` per store, `data-postgres-0`); E: pod-delete persistence check | PASS | — |
| Ingress, stable URLs, local domain documented | `gateway.yaml`, `wordpress.yaml`, README | L: Ingress `app.localtest.me`, `store.localtest.me`, `<slug>.store.localtest.me`; `curl` 200 on `/healthz`, `/readyz`, storefront | PASS | — |
| Readiness + liveness on every workload; requests + limits | all templates | L: every Deployment/StatefulSet has both probes and requests/limits; setup Job has requests/limits | PASS | — |
| No hardcoded secrets; Kubernetes Secrets | `scripts/create-secrets.sh`, `secretRef`s | Full-history scan of 15 commits: no key patterns, `.env` never committed, `.env` values absent from history; L: Secrets referenced by name only | PASS | — |

### WooCommerce MCP server

| Requirement | Files | Evidence | Result | Remaining action |
|---|---|---|---|---|
| Written by us | `apps/woocommerce-mcp` | Code review | PASS | — |
| Streamable HTTP | `src/main.ts` (`createMcpHandler`) | T: `server.test.ts` via `StreamableHTTPClientTransport` | PASS | — |
| list/create products, list/get orders, update status | `src/server.ts` | T: "exposes exactly the five required tools", create/update/list tests; E: against WooCommerce 11.2.1 | PASS | — |
| Not reachable from outside; gateway only | `woocommerce-mcp.yaml`, `store/templates/networkpolicy.yaml` | L: ClusterIP, no Ingress, `store.localtest.me/mcp` → 404, only Traefik is non-ClusterIP; bearer token; E: NetworkPolicy probes | PASS | — |
| Documented store access (REST, OAuth 1.0a) | `docs/design.md` decision 5 | Doc review; T: OAuth1 signature tests | PASS | — |

### Gateway

| Requirement | Files | Evidence | Result | Remaining action |
|---|---|---|---|---|
| Add/edit/disable/remove; optional bearer/header credential | `servers.ts`, `api.ts`, `Servers.tsx` | T: credential, disable, authType-none tests; toolbox uses the header type, woocommerce bearer | PASS | — |
| One endpoint; list all enabled; route correctly | `mcp.ts`, `broker.ts`, `upstreams.ts` | T: "aggregates tools from every enabled server"; L: an MCP client connected through the gateway lists tools from 5 servers | PASS | — |
| Duplicate-name scheme, documented | `exposedToolName`, design.md | T: collision + naming tests (`shop__echo` / `util__echo`) | PASS | — |
| Slow/dead upstream isolated; timeouts; clear error | `upstreams.ts` | T: slow-upstream and dead-upstream tests; E: `make e2e` on k3d | PASS | Re-run on HEAD (P0) |
| Credentials never sent to browser/client | `publicServer`, `crypto.ts` | T: "credential is used server-side but never returned or stored in plaintext"; E: leak scan of API/MCP/bundle | PASS | — |
| ≥ 3 upstream servers | seed in `create-secrets.sh` | L: `woocommerce`, `toolbox`, `everything`, `store-north`, `store-south-bang-12` all `connected` | PASS | — |

### Team and access

| Requirement | Files | Evidence | Result | Remaining action |
|---|---|---|---|---|
| Admin and member roles, backend-enforced | `api.ts` (`requireAdmin`), `broker.ts` (`mayUseTool`) | Code review: every admin route checks server-side; T: "member cannot manage servers or invite users", hidden-and-rejected tool tests | PASS | — |
| Own API keys, hashed, revocable | `auth.ts`, `crypto.ts` | T: revoke → 401 on next call, audited; schema test (hashed/encrypted only); L: missing/malformed key → 401 | PASS | — |
| Audit: user, server, tool, time, duration, outcome; in dashboard | `broker.ts`, `Audit.tsx`, migration 004 | T: audit tests incl. pending-first durability; L: live rows across `ok`, `denied`, `auth_rejected`, `timeout`, `tool_error`, `not_found` | PASS | — |

### Chat agent

| Requirement | Files | Evidence | Result | Remaining action |
|---|---|---|---|---|
| LLM tool loop through the gateway; shows tool calls | `agent.ts`, `Chat.tsx` | T: tool-loop test with a scripted model; L: 21 audit rows on channel `chat`; E: Azure OpenAI run | PASS | — |
| Acts as the logged-in user | `api.ts` `/chat` → `broker.callTool(principal, 'chat', …)` | T: "audit row is attributed to them on the chat channel" | PASS | — |
| LLM key server-side only | `config.ts`, `gateway-llm` Secret | L: Secret exists (key names only inspected); `.env` gitignored | PASS | — |

### Definition-of-done demo flow

| Step | Evidence | Result |
|---|---|---|
| Storefront checkout (COD), order in WC admin | E | NV on HEAD (store code unchanged since) |
| Chat as user A: create product, "orders today" | E (Azure OpenAI) | NV on HEAD |
| External client as user B; two-server prompt | E (MCP Inspector, Claude Code 2026-10-25); L: a gateway MCP client is connected in this session | PASS (pre-HEAD) |
| Revoke B's key; disable server; kill pod; audit | T + E (`make e2e` 18/18) | Re-run on HEAD (P0) |

### Bonus: multi-store provisioning

| Requirement | Evidence | Result |
|---|---|---|
| Create/delete from dashboard, status, concurrent | T: retry-safe create, per-user limit, concurrent; L: 2 stores `ready` | PASS |
| Own namespace, DB, Secrets, PVs, Ingress | L: `store-north`, `store-south-bang-12` each with MariaDB, PVCs, Secrets, Ingress | PASS |
| Automatic MCP registration, store-named tools | L: `store-north__*`, `store-south-bang-12__*` exposed | PASS |
| Clean teardown | T: delete test; L (after redeploy): disposable store deleted, namespace/PVs/registration/tools gone | PASS |
| Isolation with NetworkPolicies | L: 6 policies per store namespace; E: cross-store probes | PASS |
| ResourceQuota, LimitRange, max per user, timeout | L: quota + LimitRange in every store namespace; T: limit and deadline tests | PASS |
| Recovery / retry | T: lease takeover, locked Helm release, deadline → Failed → Retry; E: provisioner restart mid-install | PASS |
| Cross-store order comparison | E (chat called both stores' `list_orders`) | NV on HEAD |

## Findings

Copilot never reviewed PR #1: its only review reads *"Copilot was unable to review this pull request
because the user who requested the review has insufficient remaining quota."* The repository has 0 inline,
0 commit and 0 issue comments, so there were no Copilot findings to triage; this review covers that instead.

| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | **High** (demo/security) | Live cluster runs a pre-HEAD build. Migrations `003`/`004` missing (only `001`, `002` applied), no tenant ClusterRole, no ValidatingAdmissionPolicy; the running provisioner's ClusterRole grants get/list/update/delete on Secrets and create on Deployments/Jobs **in every namespace** (on k3s effectively cluster-admin). | **Open: P0**, needs your approval to redeploy |
| F2 | **Medium** (security) | Store namespaces had no Pod Security Admission. The tenant role may create Deployments/Jobs there, so a stolen provisioner token could start a privileged/hostPath pod and take over the node, i.e. the cluster. The threat model claimed "outside store namespaces: nothing". | **Fixed**: namespaces created with `pod-security.kubernetes.io/enforce: baseline`; admission policy requires it on create (the provisioner cannot relabel); chart invariant + regression test; docs corrected. Server-side dry-run confirmed every existing store pod complies with `baseline` (`restricted` would reject WordPress) |
| F3 | Medium (evidence) | No VPS/k3s deployment performed; "deployable" rests on rendered, schema-validated prod values. | Disclosed in README |
| F4 | Low | Non-UUID ids in `PUT/DELETE /api/servers/:id` and `PATCH /api/users/:id` return 500 `internal` (Postgres 22P02) instead of 404. No data exposure. | Open, accepted |
| F5 | Low | Members' `GET /api/servers` includes `lastError`, which can contain internal hostnames/IPs (never credentials). | Open, accepted |
| F6 | Low | No login rate limiting or lockout (scrypt cost bounds throughput; libuv threadpool bounds memory). Threat model notes "rate limits not implemented". | Open, disclosed |
| F7 | Low | SSRF block list omits some special-purpose ranges (198.18.0.0/15, 192.0.0.0/24, 6to4 `2002::/16`). The gateway's egress NetworkPolicy still excludes private ranges and 169.254.0.0/16 at the network layer. | Open, defence in depth holds |
| F8 | Low | `engines: node >=22.19` admits Node 23.0–23.7, where `undici@8` fails to load (no `zlib.createZstdDecompress`); all gateway tests fail on 23.6. `.node-version`, CI and images use 24. | Open; use Node 24 |
| F9 | Low | `list_orders created_on` uses `before=<day>T23:59:59` (exclusive), so an order in the last second of the day is missed. | Open, accepted |
| F10 | Low (docs) | design.md diagram showed `--set host=…`; the code deliberately uses a values file. README's "not yet verified" note listed only migration 003. | **Fixed** |
| F11 | Info | `make status` and `scripts/create-secrets.sh` print the dashboard and WordPress admin passwords. | Keep off the recording |
| F12 | Info | Biome reports a config-schema migration notice (`biome migrate`); lint passes. | — |

Reviewed with no defect found: broker authorization (list and call share `mayUseTool`), key verification
(constant-time, uncached, so revocation is immediate), session cookie (HttpOnly, SameSite=Strict) plus
JSON-only CSRF guard, invite single-use under concurrency, AES-256-GCM credentials, pending-first audit
durability, SSRF guard at registration and connect time (DNS rebinding, IPv4-mapped IPv6, redirects
refused), per-upstream timeouts and in-flight cap, no retries for `tools/call`, store-name → Helm through a
values file only, quoted `store.title` env in the setup Job, provisioner lease/`SKIP LOCKED` reconciliation,
foreign namespace/server never adopted, migration advisory lock, non-root images (5/5 run as `node`),
`automountServiceAccountToken: false` except the provisioner.

## Commands run and results

Node 24.22.0 (checksum-verified download; the machine's Node 23.6.0 cannot load `undici@8`), pnpm 10.28.0 via
corepack, Postgres 14.20 on a throwaway local instance, Helm 4.3.1, kubeconform 0.8.0, Docker 29.5.3.

| Command | Result |
|---|---|
| `git status --short`, `git diff --stat`, `git diff --cached --stat` | Clean at start; HEAD = `origin/urumi-implementation` = `e5c1d1a` |
| `pnpm install --frozen-lockfile` | OK |
| `pnpm lint` | OK (61 files, 1 info) |
| `pnpm typecheck` | OK (4 packages) |
| `TEST_DATABASE_URL=… pnpm test` (Node 23.6.0) | gateway 0/8 files load: `undici` zstd `TypeError` (environment) |
| `TEST_DATABASE_URL=… pnpm test` (Node 24.22.0), before and after the fix | gateway 81/81, woocommerce-mcp 9/9, toolbox-mcp 3/3, dashboard 4/4; 0 skipped |
| `node --test test/stores.test.ts` with HEAD's `provisioner.ts` vs fixed | 12 pass / 1 fail (expects `baseline`) vs 13/13 |
| `pnpm build` | OK (dashboard 242 kB JS) |
| `docker build --target … && scripts/image-check.sh` × 5 | 5/5 PASS, all `user=node`; store-provisioner rebuilt after the fix: PASS |
| `make charts-check`, before and after the fix | 4/4 renders valid; 4/4 invariants PASS (invariant 3 now includes Pod Security) |
| `kubectl apply --dry-run=server` on the rendered admission policy | Accepted (CEL compiles), nothing persisted |
| `kubectl label --dry-run=server ns <store ns> pod-security.kubernetes.io/enforce=baseline` × 3 | No violations; `restricted` flags WordPress only |
| Read-only `kubectl get` (pods, PVCs, Ingress, NetworkPolicies, quotas, probes/resources, ClusterRoles, VAPs, namespace labels, Helm releases) | See matrix and F1 |
| `psql` in `postgres-0`: `schema_migrations`, server statuses, audit outcome/channel counts | `001`, `002` only; 5 servers connected; audit rows on `mcp` and `chat` |
| `curl` `/healthz`, `/readyz`, `/mcp` (no / malformed key), `/api/servers` (no session), form POST, `/` headers, storefront | 200, 200, 401, 401, 401, 400, CSP + nosniff, 200 |
| GitHub API: PR #1, reviews, comments, check runs for `e5c1d1a` | Open, mergeable/clean, 14 commits; all CI jobs `success` |
| Full-history secret scan (15 commits) | No matches |

Not run: `make e2e` (creates a user, keys and a product, toggles `toolbox`, scales `everything-mcp` to 0),
`make up` / `deploy-local` (changes the cluster), any store create/delete.

## Live k3d deployment verification (2026-10-26)

| Step | Evidence |
|---|---|
| Backup | `pg_dump -Fc` of the gateway DB and `mariadb-dump` of all three stores to `~/urumi-backups/<timestamp>/` (mode 700/600, outside the repo); gateway dump test-restored into a throwaway Postgres 18 with identical row counts |
| Migration dry run | `003`, `004` applied to the restored copy: OK; only `store-north` and `store-south-bang-12` get linked |
| Rollback safety | Running images tagged `urumi/*:pre-review` in the node's containerd (`:dev` is reused); Postgres StatefulSet render identical before and after, so no immutable-field change |
| Deploy | `make images import`, `make deploy-local`: `store` rev 4, `platform` rev 6; then `rollout restart` of `toolbox-mcp` and the three `woocommerce-mcp` Deployments (same tag, new image) |
| Health | All gateway, provisioner and MCP pods run the new image IDs, 0 restarts; gateway 2/2, provisioner 1/1 (`store-provisioner started`, i.e. its least-privilege self-check passed); `/readyz` ok |
| Migrations | `schema_migrations`: `001`–`004` |
| Existing stores | Orders/products identical to the pre-deploy dumps (`store` 4/12, `north` 1/1, `south-bang-12` 0/0); storefronts 200; all upstreams `connected`; 7 PVCs Bound |
| RBAC (`kubectl auth can-i --as=system:serviceaccount:platform:store-provisioner`) | **no**: get secrets in `platform`, list secrets cluster-wide, create deployments/pods in `kube-system`, create clusterrolebindings, update clusterroles, bind `cluster-admin`, patch/update namespaces, any right in the static `store` namespace; in store namespaces: get/list/update/delete of `store-db` / `store-wp-admin`, create serviceaccounts. **yes**: create/delete namespaces, create rolebindings, bind `platform-store-tenant`; in store namespaces: create secrets, get `woocommerce-mcp-auth`, create deployments/configmaps |
| Admission policy (server-side dry run as the provisioner) | Denied: namespace `evil`; `store-zz` without store labels, without the Pod Security label, or with `privileged`; RoleBinding in `kube-system`; RoleBinding to another subject; RoleBinding to `cluster-admin` (RBAC escalation check); delete of namespace `store`. Allowed: a correctly labelled `store-*` namespace; the tenant role bound to itself in a store namespace |
| Migration step for existing stores | RoleBinding `store-provisioner` + label `pod-security.kubernetes.io/enforce=baseline` on `store-north`, `store-south-bang-12` (no Pod Security warnings) |
| Disposable store `rvtmp-1826` | Created through `/api/stores`, Ready in 76 s; namespace labelled `urumi.io/store`, `store-id`, `pod-security…=baseline`; RoleBinding created by the provisioner; 3 pods Ready, 2 PVCs Bound, Ingress, 6 NetworkPolicies, quota + LimitRange; storefront 200; Helm release in a ConfigMap (0 Helm Secrets) |
| Registration and call | Gateway server `store-rvtmp-1826` `connected` with 5 tools; `tools/list` through `/mcp` includes `store-rvtmp-1826__*`; `store-rvtmp-1826__list_products` → `isError=false`, `[]`; audit row `mcp / list_products / ok / 226 ms` |
| Teardown | `DELETE /api/stores/:id` → 200; tools gone from `tools/list` immediately; store gone after 25 s; namespace, both PVs, RoleBinding, Helm release, store row and server row all gone; other stores unchanged |

Temporary admin API keys created for the MCP calls were revoked by the script.

## Files changed in this review

| File | Why |
|---|---|
| `apps/gateway/src/provisioner.ts` | F2: create store namespaces with Pod Security `baseline` |
| `apps/gateway/test/stores.test.ts` | F2: regression assertion on the namespace label |
| `deploy/charts/platform/templates/provisioner.yaml` | F2: admission policy requires `baseline`/`restricted` on namespaces the provisioner creates |
| `scripts/chart-checks.sh` | F2: CI invariant for that admission rule |
| `docs/threat-model.md` | F2: correct the "outside store namespaces: nothing" claim; Pod Security bullet |
| `docs/design.md` | F2: label existing store namespaces in the migration steps; F10: diagram matches the values-file code path |
| `README.md` | F10: accurate list of what is not yet deployed to k3d |
| `docs/submission-readiness.md` | This report |

Nothing was committed, pushed or deployed.

## Remaining actions, in order

**P0: redeploy HEAD and re-verify (about 20–30 min).** Changes the cluster, so run it yourself. Check first
that no store is Provisioning or Deleting.

```bash
make images import                       # rebuild and import all five images
make deploy-local                        # both Helm releases; restarts the gateway (applies migrations 003, 004)
kubectl -n platform rollout status deploy/store-provisioner
kubectl -n platform rollout status deploy/gateway
kubectl -n platform logs deploy/store-provisioner | head -3     # expect "store-provisioner started"
kubectl auth can-i get secrets -n platform --as=system:serviceaccount:platform:store-provisioner   # expect: no
for ns in store-north store-south-bang-12; do
  kubectl -n $ns create rolebinding store-provisioner --clusterrole=platform-store-tenant \
    --serviceaccount=platform:store-provisioner
  kubectl label ns $ns pod-security.kubernetes.io/enforce=baseline
done
kubectl get validatingadmissionpolicy                            # platform-store-provisioner
make e2e                                                         # expect "all checks passed"
```

Then, before recording: create a throwaway store in the dashboard, wait for Ready, delete it, and confirm the
namespace and its PVs are gone (`kubectl get ns,pv`). That exercises teardown on HEAD's RBAC.

**P1: record the demo** on the redeployed cluster, with host sleep disabled (README). Follow the brief's six
sections. Do not show `make status` / `create-secrets.sh` output.

**P1: commit and push** this review's changes once you approve them; confirm CI is green on the new HEAD.

**P2 (optional):** a k3s VPS deployment would turn F3 into PASS; only if time remains after the video.

## Submission checklist

- [ ] Review the diff from this review, commit, push; latest commit on `urumi-implementation` matches local
- [ ] CI green on that commit (code, images × 5, charts)
- [ ] PR #1 description up to date (note: Copilot did not review, quota)
- [ ] Decide whether to merge PR #1 into `main` or submit the branch URL; make sure the URL you submit shows the final code
- [ ] Repository public (it is) and README renders; the brief stays excluded (`.gitignore`)
- [ ] P0 redeploy done, `make e2e` passes, store create/delete checked
- [ ] Demo video recorded: two users, DoD flow, Kubernetes, MCP internals, security, chat, local → VPS story
- [ ] Video link opens in a private/incognito window (sharing set to "anyone with the link")
- [ ] Form submitted (https://forms.gle/nftwgyNeenSDmiRb6) with video + repo links before 23:59 IST

## Likely interview questions

**Architecture**
- Why does the chat agent call the broker in-process rather than the `/mcp` endpoint with a minted key?
- Why is the dashboard served by the gateway instead of its own Deployment, and what does same-origin buy you?
- Why Postgres as the provisioner's desired-state store instead of a CRD and operator?

**MCP routing**
- Walk through a `tools/call` from Claude Code to MariaDB and back. Where are auth, routing, timeout and audit applied?
- How does `<slug>__<tool>` stay unambiguous? What happens to a 70-character tool name?
- Stateless SDK v2: how do two replicas serve one client without sticky sessions? How does a replica learn about a server added through the other?

**Kubernetes**
- What is public and what is internal-only, and which object enforces each (Service type, Ingress, NetworkPolicy, bearer token)?
- Why does the woocommerce-mcp readiness probe not check the store? (Helm post-install hook deadlock.)
- What exactly can the store-provisioner do, and what stops it from touching `kube-system`? (RBAC, admission policy, Pod Security.)

**Security**
- What can a member do with an upstream credential they never see? Why aren't client tokens passed through?
- An admin registers a malicious MCP server: what can its tool descriptions or results do, and what limits them?
- How do you defeat DNS rebinding and `::ffff:169.254.169.254`?

**Failure and recovery**
- An upstream hangs mid-`create_product`. What does the client see, what does the audit log say, and why no retry?
- The provisioner pod dies during `helm upgrade`. What happens to the store?
- The audit insert fails. Is the tool still called?

**Trade-offs**
- What would change for 10 servers and hundreds of tools?
- What is the single weakest point you would fix next (residual provisioner risk, rate limits, VPS evidence)?
