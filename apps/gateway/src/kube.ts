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
  /**
   * The store's MCP token (Secret woocommerce-mcp-auth), the only Secret the provisioner reads: it registers
   * the store in the gateway with it. RBAC grants `get` on that Secret name only.
   */
  readMcpToken(namespace: string): Promise<string | null>;
  /** Creates the Secret unless it exists. Never reads, updates or overwrites one. */
  createSecret(namespace: string, name: string, data: Record<string, string>): Promise<void>;
  /**
   * Binds the provisioner to its namespaced rights inside one store namespace (RoleBinding to the tenant
   * ClusterRole). It holds no such rights cluster-wide, so this runs before anything else in the namespace.
   * An existing binding is verified, never trusted by name.
   */
  ensureAccess(namespace: string): Promise<void>;
  /** Whether this identity may perform the action (SelfSubjectAccessReview). */
  allowed(check: AccessCheck): Promise<boolean>;
}

export interface AccessCheck {
  verb: string;
  resource: string;
  group?: string;
  /** Omitted: cluster-wide (all namespaces). */
  namespace?: string;
}

/** One Kubernetes API request; throws KubeError for non-2xx responses. */
export type KubeCall = (method: string, path: string, body?: unknown) => Promise<Record<string, unknown>>;

export const MCP_TOKEN_SECRET = 'woocommerce-mcp-auth';
const BINDING = 'store-provisioner';

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
  return kubeClient(call, access);
}

/** The provisioner's Kubernetes operations over any transport (tests pass a fake `call`). */
export function kubeClient(call: KubeCall, access: KubeAccess): Kube {
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
    async readMcpToken(namespace) {
      assertStoreNamespace(namespace);
      try {
        const s = (await call('GET', `/api/v1/namespaces/${namespace}/secrets/${MCP_TOKEN_SECRET}`)) as {
          data?: Record<string, string>;
        };
        const token = s.data?.MCP_AUTH_TOKEN;
        return token ? Buffer.from(token, 'base64').toString('utf8') : null;
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
      const path = `/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/rolebindings`;
      const roleRef = { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: access.tenantRole };
      const subject = { kind: 'ServiceAccount', ...access.serviceAccount };
      try {
        await call('POST', path, {
          metadata: { name: BINDING, labels: { 'app.kubernetes.io/managed-by': 'store-provisioner' } },
          roleRef,
          subjects: [subject],
        });
      } catch (err) {
        if (!exists(err)) throw err;
        // A binding with this name exists: use it only if it is exactly the one we would have created.
        const rb = (await call('GET', `${path}/${BINDING}`)) as {
          roleRef?: Record<string, string>;
          subjects?: Record<string, string>[];
        };
        const s = rb.subjects ?? [];
        const ok =
          rb.roleRef?.apiGroup === roleRef.apiGroup &&
          rb.roleRef?.kind === roleRef.kind &&
          rb.roleRef?.name === roleRef.name &&
          s.length === 1 &&
          s[0]?.kind === subject.kind &&
          s[0]?.name === subject.name &&
          s[0]?.namespace === subject.namespace;
        if (!ok) {
          throw new Error(
            `RoleBinding ${BINDING} in ${namespace} does not bind ClusterRole ${roleRef.name} to ` +
              `${subject.namespace}/${subject.name} only; refusing to use it (inspect who changed it)`,
          );
        }
      }
    },
    async allowed({ verb, resource, group = '', namespace }) {
      const review = await call('POST', '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
        apiVersion: 'authorization.k8s.io/v1',
        kind: 'SelfSubjectAccessReview',
        spec: { resourceAttributes: { verb, resource, group, ...(namespace ? { namespace } : {}) } },
      });
      return (review.status as { allowed?: boolean } | undefined)?.allowed === true;
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

/**
 * Helm keeps release records in ConfigMaps rather than Secrets, so the provisioner needs no read access to
 * Secrets in store namespaces (the store chart itself creates none and uses no `lookup`).
 */
export const HELM_ENV = { HELM_DRIVER: 'configmap' } as const;

/** Runs the helm CLI (in-cluster config) against the store chart. Release name is "store" in every namespace. */
export function helmCli(opts: { chartDir: string; valuesFile: string }): Helm {
  function helm(args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const options = {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...HELM_ENV },
      };
      execFile('helm', args, options, (err, stdout, stderr) => {
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
