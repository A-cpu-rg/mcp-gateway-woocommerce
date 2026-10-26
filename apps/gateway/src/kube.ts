import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';

// The two things the store-provisioner does to the cluster, behind small interfaces so the reconcile logic
// is testable without a cluster. Only the provisioner uses this; the gateway has no Kubernetes credentials.

export interface Kube {
  getNamespace(name: string): Promise<{ labels: Record<string, string>; terminating: boolean } | null>;
  createNamespace(name: string, labels: Record<string, string>): Promise<void>;
  deleteNamespace(name: string): Promise<void>;
  getSecret(namespace: string, name: string): Promise<Record<string, string> | null>;
  /** Creates the Secret unless it exists; an existing Secret is never overwritten. */
  createSecret(namespace: string, name: string, data: Record<string, string>): Promise<void>;
  /**
   * Binds the provisioner to its namespaced rights inside one store namespace (RoleBinding to the tenant
   * ClusterRole). It holds no such rights cluster-wide, so this runs before anything else in the namespace.
   */
  ensureAccess(namespace: string): Promise<void>;
}

/** Who the provisioner is, and the ClusterRole it binds itself to inside each store namespace. */
export interface KubeAccess {
  tenantRole: string;
  serviceAccount: { name: string; namespace: string };
}

export interface Helm {
  /** Release status ("deployed", "pending-install", ...) or null when there is no release. */
  status(namespace: string): Promise<string | null>;
  upgradeInstall(namespace: string, set: Record<string, string>, timeoutSeconds: number): Promise<void>;
  uninstall(namespace: string): Promise<void>;
}

/** Defence in depth on top of RBAC: the provisioner only ever acts on store namespaces. */
export function assertStoreNamespace(name: string): void {
  if (!/^store-[a-z][a-z0-9-]{1,17}$/.test(name)) throw new Error(`refusing to touch namespace "${name}"`);
}

export class KubeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

/** Kubernetes REST client authenticated with the pod's ServiceAccount token. */
export function inClusterKube(access: KubeAccess): Kube {
  const base = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`;
  const dispatcher = new Agent({ connect: { ca: readFileSync(`${SA}/ca.crt`) } });

  async function call(method: string, path: string, body?: unknown) {
    // The token is re-read on every call: Kubernetes rotates projected ServiceAccount tokens.
    const token = readFileSync(`${SA}/token`, 'utf8').trim();
    const res = await undiciFetch(`${base}${path}`, {
      method,
      dispatcher,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new KubeError(res.status, `${method} ${path}: ${json.message ?? res.status}`);
    return json;
  }
  const missing = (err: unknown) => err instanceof KubeError && err.status === 404;
  const exists = (err: unknown) => err instanceof KubeError && err.status === 409;

  return {
    async getNamespace(name) {
      assertStoreNamespace(name);
      try {
        const ns = (await call('GET', `/api/v1/namespaces/${name}`)) as {
          metadata: { labels?: Record<string, string> };
          status?: { phase?: string };
        };
        return { labels: ns.metadata.labels ?? {}, terminating: ns.status?.phase === 'Terminating' };
      } catch (err) {
        if (missing(err)) return null;
        throw err;
      }
    },
    async createNamespace(name, labels) {
      assertStoreNamespace(name);
      await call('POST', '/api/v1/namespaces', { metadata: { name, labels } }).catch((err) => {
        if (!exists(err)) throw err;
      });
    },
    async deleteNamespace(name) {
      assertStoreNamespace(name);
      await call('DELETE', `/api/v1/namespaces/${name}`).catch((err) => {
        if (!missing(err)) throw err;
      });
    },
    async getSecret(namespace, name) {
      assertStoreNamespace(namespace);
      try {
        const s = (await call('GET', `/api/v1/namespaces/${namespace}/secrets/${name}`)) as {
          data?: Record<string, string>;
        };
        return Object.fromEntries(
          Object.entries(s.data ?? {}).map(([k, v]) => [k, Buffer.from(v, 'base64').toString('utf8')]),
        );
      } catch (err) {
        if (missing(err)) return null;
        throw err;
      }
    },
    async createSecret(namespace, name, data) {
      assertStoreNamespace(namespace);
      await call('POST', `/api/v1/namespaces/${namespace}/secrets`, {
        metadata: { name, labels: { 'app.kubernetes.io/managed-by': 'store-provisioner' } },
        type: 'Opaque',
        stringData: data,
      }).catch((err) => {
        if (!exists(err)) throw err;
      });
    },
    async ensureAccess(namespace) {
      assertStoreNamespace(namespace);
      await call('POST', `/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/rolebindings`, {
        metadata: {
          name: 'store-provisioner',
          labels: { 'app.kubernetes.io/managed-by': 'store-provisioner' },
        },
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: access.tenantRole },
        subjects: [{ kind: 'ServiceAccount', ...access.serviceAccount }],
      }).catch((err) => {
        if (!exists(err)) throw err;
      });
    },
  };
}

/** Dotted keys ("store.title") to the nested object a Helm values file holds. Values stay literal strings. */
export function nestValues(set: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(set)) {
    const parts = key.split('.');
    let node = out;
    for (const part of parts.slice(0, -1)) {
      node[part] ??= {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts[parts.length - 1] as string] = value;
  }
  return out;
}

/**
 * Arguments for `helm upgrade --install`. Per-store values come only from a values file: --set and
 * --set-string split on "," and "=", so a store name such as "Shop,host=app.example.com" would otherwise set
 * other chart values (the Ingress host, container images, quotas).
 */
export function helmUpgradeArgs(
  opts: { chartDir: string; valuesFile: string },
  namespace: string,
  storeValuesFile: string,
  timeoutSeconds: number,
): string[] {
  const seconds = Math.max(60, Math.floor(timeoutSeconds));
  return [
    'upgrade',
    '--install',
    'store',
    opts.chartDir,
    '-n',
    namespace,
    '-f',
    opts.valuesFile,
    '-f',
    storeValuesFile,
    '--wait',
    '--timeout',
    `${seconds}s`,
  ];
}

/** Runs the helm CLI (in-cluster config) against the store chart. Release name is "store" in every namespace. */
export function helmCli(opts: { chartDir: string; valuesFile: string }): Helm {
  function helm(args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('helm', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message).trim().split('\n').slice(-3).join(' ').slice(0, 400);
          reject(new Error(`helm ${args[0]}: ${detail}`));
        } else resolve(stdout);
      });
    });
  }
  return {
    async status(namespace) {
      assertStoreNamespace(namespace);
      const out = await helm(['list', '-n', namespace, '-a', '-o', 'json', '--filter', '^store$'], 30_000);
      const list = JSON.parse(out || '[]') as { status: string }[];
      return list[0]?.status ?? null;
    },
    async upgradeInstall(namespace, set, timeoutSeconds) {
      assertStoreNamespace(namespace);
      const dir = await mkdtemp(join(tmpdir(), 'store-values-'));
      const file = join(dir, 'values.json'); // JSON is valid YAML
      try {
        await writeFile(file, JSON.stringify(nestValues(set)), { mode: 0o600 });
        const args = helmUpgradeArgs(opts, namespace, file, timeoutSeconds);
        await helm(args, (Math.max(60, Math.floor(timeoutSeconds)) + 30) * 1000);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async uninstall(namespace) {
      assertStoreNamespace(namespace);
      await helm(['uninstall', 'store', '-n', namespace, '--wait', '--ignore-not-found'], 300_000);
    },
  };
}
