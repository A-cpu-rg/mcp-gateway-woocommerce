import { randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import { type AccessCheck, type Helm, type Kube, MCP_TOKEN_SECRET } from './kube.ts';
import { createServer } from './servers.ts';
import { type StoreRow, storeServerSlug } from './stores.ts';
import type { ServerRow, UpstreamPool } from './upstreams.ts';

// Reconciles the stores table towards the cluster. Every step is idempotent (create-if-missing,
// helm upgrade --install, register-if-missing), so a store can be retried, and a provisioner that restarts
// mid-way simply runs the same steps again once its lease expires. Only the deadline turns a store "failed".

export interface ProvisionerDeps {
  db: Db;
  kube: Kube;
  helm: Helm;
  pool: UpstreamPool;
  key: Buffer;
  allowedHosts: string[];
  /** Namespace of the gateway pods (store NetworkPolicies admit them). */
  gatewayNamespace: string;
  /** Unique per process, e.g. the pod name. */
  id: string;
  concurrency: number;
  leaseMs: number;
  /** Wait before retrying a step that failed transiently. */
  backoffMs: number;
  /** How long one pass waits for the gateway to report the store's MCP server connected (default 60 s). */
  connectWaitMs?: number;
  /** How often it checks while waiting (default 2 s). */
  pollMs?: number;
  /** Where a store's MCP server is reached (tests point this at a local server). */
  storeMcpUrl?: (namespace: string) => string;
}

const LABEL_STORE = 'urumi.io/store';
const LABEL_STORE_ID = 'urumi.io/store-id';
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const defaultMcpUrl = (ns: string) => `http://woocommerce-mcp.${ns}.svc.cluster.local:8080/mcp`;

/** A step that cannot succeed by retrying (e.g. the namespace belongs to someone else). */
class PermanentError extends Error {}

/**
 * Rights the provisioner must not hold. Any of them means the cluster still runs RBAC from an older chart (a
 * cluster-wide role over Secrets and workloads), or someone widened it. Checked at startup.
 */
export function forbiddenRights(platformNamespace: string): AccessCheck[] {
  return [
    { verb: 'get', resource: 'secrets', namespace: platformNamespace },
    { verb: 'list', resource: 'secrets' },
    { verb: 'create', resource: 'deployments', group: 'apps', namespace: 'kube-system' },
    { verb: 'create', resource: 'pods', namespace: 'kube-system' },
    { verb: 'update', resource: 'clusterroles', group: 'rbac.authorization.k8s.io' },
  ];
}

/** Throws when the provisioner holds rights it must not: it then refuses to work instead of operating with them. */
export async function assertLeastPrivilege(kube: Kube, platformNamespace: string): Promise<void> {
  const held: string[] = [];
  for (const c of forbiddenRights(platformNamespace)) {
    if (await kube.allowed(c))
      held.push(
        `${c.verb} ${c.group ? `${c.group}/` : ''}${c.resource} in ${c.namespace ?? 'all namespaces'}`,
      );
  }
  if (held.length) {
    throw new Error(
      `store-provisioner holds rights it must not have (${held.join('; ')}). The cluster runs RBAC from an older ` +
        'platform chart: upgrade the chart (docs/design.md, "Provisioner RBAC migration") before starting it.',
    );
  }
}

export class Provisioner {
  readonly #d: ProvisionerDeps;
  readonly #working = new Map<string, Promise<void>>();

  constructor(deps: ProvisionerDeps) {
    this.#d = deps;
  }

  get id(): string {
    return this.#d.id;
  }

  /** Claims free work up to the concurrency limit and starts it. Returns the started jobs. */
  async tick(): Promise<Promise<void>[]> {
    const free = this.#d.concurrency - this.#working.size;
    if (free <= 0) return [];
    // FOR UPDATE SKIP LOCKED + lease: several provisioners (or a restarted one) never work on the same
    // store at once, and work held by a dead process becomes claimable when its lease expires.
    const { rows } = await this.#d.db.query<StoreRow>(
      `UPDATE stores SET lease_owner = $1, lease_until = now() + make_interval(secs => $2)
       WHERE id IN (
         SELECT id FROM stores
         WHERE status IN ('provisioning', 'deleting') AND (lease_until IS NULL OR lease_until < now())
           AND NOT (id = ANY($4::uuid[]))
         ORDER BY updated_at LIMIT $3 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [this.#d.id, this.#d.leaseMs / 1000, free, [...this.#working.keys()]],
    );
    return rows.map((row) => {
      const job = this.#run(row).finally(() => this.#working.delete(row.id));
      this.#working.set(row.id, job);
      return job;
    });
  }

  /** Waits for in-flight work (tests and graceful shutdown). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.#working.values()]);
  }

  async #run(row: StoreRow): Promise<void> {
    // Keep the lease while a long step (helm --wait) runs, so no other provisioner takes the store over.
    const renew = setInterval(() => {
      this.#d.db
        .query(
          'UPDATE stores SET lease_until = now() + make_interval(secs => $3) WHERE id = $1 AND lease_owner = $2',
          [row.id, this.#d.id, this.#d.leaseMs / 1000],
        )
        .catch(() => {});
    }, this.#d.leaseMs / 3);
    try {
      if (row.status === 'deleting') await this.#teardown(row);
      else await this.#provision(row);
    } catch (err) {
      await this.#onError(row, err);
    } finally {
      clearInterval(renew);
    }
  }

  async #step(row: StoreRow, reason: string): Promise<void> {
    await this.#d.db.query('UPDATE stores SET status_reason = $2, updated_at = now() WHERE id = $1', [
      row.id,
      reason,
    ]);
    row.status_reason = reason;
  }

  async #onError(row: StoreRow, err: unknown): Promise<void> {
    const message = (err as Error).message.slice(0, 400);
    const pastDeadline = Date.now() >= row.deadline_at.getTime();
    if (row.status === 'provisioning' && (err instanceof PermanentError || pastDeadline)) {
      const reason = pastDeadline ? `Timed out during "${row.status_reason}": ${message}` : message;
      await this.#d.db.query(
        `UPDATE stores SET status = 'failed', status_reason = $2, lease_until = NULL, updated_at = now()
         WHERE id = $1 AND status = 'provisioning'`,
        [row.id, reason],
      );
      console.error(JSON.stringify({ msg: 'store failed', store: row.slug, reason }));
      return;
    }
    // Transient: keep the status, show why, and come back after a backoff.
    await this.#d.db.query(
      `UPDATE stores SET status_reason = $2, lease_until = now() + make_interval(secs => $3), updated_at = now()
       WHERE id = $1`,
      [row.id, `Retrying "${row.status_reason}": ${message}`, this.#d.backoffMs / 1000],
    );
    console.error(JSON.stringify({ msg: 'store step failed, will retry', store: row.slug, error: message }));
  }

  async #provision(row: StoreRow): Promise<void> {
    const { kube, helm, db } = this.#d;
    if (Date.now() >= row.deadline_at.getTime()) throw new Error('provisioning deadline passed');

    await this.#step(row, 'Creating namespace and Secrets');
    const ns = await kube.getNamespace(row.namespace);
    if (ns && ns.labels[LABEL_STORE_ID] !== row.id) {
      throw new PermanentError(`namespace ${row.namespace} already exists and does not belong to this store`);
    }
    if (ns?.terminating) throw new Error(`namespace ${row.namespace} is still terminating`);
    if (!ns) await kube.createNamespace(row.namespace, { [LABEL_STORE]: 'true', [LABEL_STORE_ID]: row.id });
    await kube.ensureAccess(row.namespace);
    const owner = (await db.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [row.owner_id]))
      .rows[0];
    // Same Secrets as scripts/create-secrets.sh creates for the first store; never overwritten.
    await kube.createSecret(row.namespace, 'store-db', {
      MARIADB_ROOT_PASSWORD: hex(24),
      MARIADB_PASSWORD: hex(24),
    });
    await kube.createSecret(row.namespace, 'store-wp-admin', {
      WP_ADMIN_USER: 'admin',
      WP_ADMIN_PASSWORD: hex(12),
      WP_ADMIN_EMAIL: owner?.email ?? 'admin@example.com',
    });
    await kube.createSecret(row.namespace, 'store-wc-api', {
      WC_CONSUMER_KEY: `ck_${hex(20)}`,
      WC_CONSUMER_SECRET: `cs_${hex(20)}`,
    });
    await kube.createSecret(row.namespace, MCP_TOKEN_SECRET, { MCP_AUTH_TOKEN: hex(32) });
    const token = await kube.readMcpToken(row.namespace);
    if (!token) throw new Error('MCP token Secret is missing');

    await this.#step(row, 'Installing WordPress, MariaDB and WooCommerce (Helm)');
    const slug = storeServerSlug(row.slug);
    let server = await this.#d.pool.serverBySlug(slug);
    // The registration grants the store owner its admin-only tools, so never adopt one made for anything else.
    const foreign = () =>
      new PermanentError(`gateway server ${slug} already exists and does not belong to this store`);
    if (server && server.store_id !== row.id) throw foreign();
    const status = await helm.status(row.namespace);
    // Installed and registered by an earlier pass that only ran out of time waiting for the gateway: go
    // straight back to waiting rather than adding another Helm revision.
    if (status !== 'deployed' || server?.store_id !== row.id) {
      // A provisioner killed during "helm upgrade" leaves the release locked in a pending state. Volumes are
      // kept (StatefulSet PVCs, resource-policy: keep), so removing the half-finished release is safe.
      if (status?.startsWith('pending')) await helm.uninstall(row.namespace);
      await helm.upgradeInstall(
        row.namespace,
        { host: row.host, 'store.title': row.name, 'gateway.namespace': this.#d.gatewayNamespace },
        (row.deadline_at.getTime() - Date.now()) / 1000,
      );
    }

    await this.#step(row, 'Registering the store MCP server in the gateway');
    // Deleted while Helm was running: registering now would expose a deleting store's tools until teardown.
    const { rows: now } = await db.query<{ status: string }>('SELECT status FROM stores WHERE id = $1', [
      row.id,
    ]);
    if (now[0]?.status !== 'provisioning') {
      // Release the lease so teardown can start on the next pass.
      await db.query('UPDATE stores SET lease_until = NULL WHERE id = $1 AND lease_owner = $2', [
        row.id,
        this.#d.id,
      ]);
      console.log(JSON.stringify({ msg: 'store no longer provisioning, not registering', store: row.slug }));
      return;
    }
    if (!server) {
      try {
        server = await createServer(
          this.#d,
          {
            slug,
            name: `Store: ${row.name}`,
            url: (this.#d.storeMcpUrl ?? defaultMcpUrl)(row.namespace),
            enabled: true,
            authType: 'bearer',
            credential: token,
            timeoutMs: 10_000,
            adminOnlyTools: ['create_product', 'update_order_status'],
          },
          { check: false, storeId: row.id },
        );
      } catch (err) {
        if ((err as { code?: string }).code !== '23505') throw err; // registered concurrently: fine
        server = await this.#d.pool.serverBySlug(slug);
      }
    }
    if (!server) throw new Error('gateway registration not found');
    if (server.store_id !== row.id) throw foreign(); // a concurrent registration by something else
    // Only the gateway may call a store's MCP server (NetworkPolicy), so the provisioner does not connect to
    // it; it waits for the gateway's health check (every replica runs one) to report the server connected.
    await this.#step(row, 'Waiting for the gateway to connect to the store MCP server');
    server = await this.#waitConnected(row, slug, server);
    if (server.status !== 'connected') {
      throw new Error(
        `gateway reports the store MCP server as ${server.status}${server.last_error ? `: ${server.last_error}` : ''}`,
      );
    }

    await db.query(
      `UPDATE stores SET status = 'ready', status_reason = NULL, ready_at = now(), lease_until = NULL,
         updated_at = now()
       WHERE id = $1 AND status = 'provisioning'`,
      [row.id],
    );
    console.log(JSON.stringify({ msg: 'store ready', store: row.slug, tools: `${slug}__*` }));
  }

  /**
   * The gateway's health check (every replica, every 10 s) moves a new server to "connected". Poll for it within
   * this pass: failing the pass instead would back off and re-run every step. Bounded by the store's deadline.
   */
  async #waitConnected(row: StoreRow, slug: string, server: ServerRow): Promise<ServerRow> {
    const until = Math.min(Date.now() + (this.#d.connectWaitMs ?? 60_000), row.deadline_at.getTime());
    let current = server;
    while (current.status !== 'connected' && Date.now() < until) {
      await new Promise((r) => setTimeout(r, this.#d.pollMs ?? 2_000));
      current = (await this.#d.pool.serverBySlug(slug)) ?? current;
    }
    return current;
  }

  async #teardown(row: StoreRow): Promise<void> {
    const { kube, helm, db } = this.#d;
    await this.#step(row, 'Removing gateway registration');
    await db.query('DELETE FROM upstream_servers WHERE store_id = $1', [row.id]);

    const ns = await kube.getNamespace(row.namespace);
    // Never delete a namespace this store did not create.
    if (ns && ns.labels[LABEL_STORE_ID] === row.id) {
      if (!ns.terminating) {
        // Stores provisioned before per-namespace RoleBindings existed get theirs here.
        await kube.ensureAccess(row.namespace);
        await this.#step(row, 'Uninstalling the Helm release');
        await helm.uninstall(row.namespace);
        await this.#step(row, 'Deleting namespace (volumes, Secrets, Ingress)');
        await kube.deleteNamespace(row.namespace);
      }
      // Namespace deletion is asynchronous (volumes are released first); finish on a later pass if needed.
      if (await kube.getNamespace(row.namespace)) {
        throw new Error(`waiting for namespace ${row.namespace} to be removed`);
      }
    }
    await db.query('DELETE FROM stores WHERE id = $1', [row.id]);
    console.log(JSON.stringify({ msg: 'store deleted', store: row.slug }));
  }
}
