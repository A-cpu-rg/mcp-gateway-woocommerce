import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
export function inClusterKube(): Kube {
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
  };
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
      const sets = Object.entries(set).flatMap(([k, v]) => ['--set-string', `${k}=${v}`]);
      const seconds = Math.max(60, Math.floor(timeoutSeconds));
      await helm(
        [
          'upgrade',
          '--install',
          'store',
          opts.chartDir,
          '-n',
          namespace,
          '-f',
          opts.valuesFile,
          ...sets,
          '--wait',
          '--timeout',
          `${seconds}s`,
        ],
        (seconds + 30) * 1000,
      );
    },
    async uninstall(namespace) {
      assertStoreNamespace(namespace);
      await helm(['uninstall', 'store', '-n', namespace, '--wait', '--ignore-not-found'], 300_000);
    },
  };
}
