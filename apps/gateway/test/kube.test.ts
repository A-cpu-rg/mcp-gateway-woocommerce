import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HELM_ENV, type Kube, kubeClient } from '../src/kube.ts';
import { assertLeastPrivilege, forbiddenRights } from '../src/provisioner.ts';
import { fakeApi } from './helpers.ts';

// The provisioner's real Kubernetes client (kubeClient) against an in-memory API that records every request.

const access = {
  tenantRole: 'platform-store-tenant',
  serviceAccount: { name: 'store-provisioner', namespace: 'platform' },
};
const goodBinding = {
  roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'platform-store-tenant' },
  subjects: [{ kind: 'ServiceAccount', name: 'store-provisioner', namespace: 'platform' }],
};

const RB = '/apis/rbac.authorization.k8s.io/v1/namespaces/store-acme/rolebindings/store-provisioner';

test('ensureAccess creates the RoleBinding to the tenant role for the provisioner only', async () => {
  const api = fakeApi();
  await kubeClient(api.call, access).ensureAccess('store-acme');
  assert.deepEqual((api.objects.get(RB) as typeof goodBinding).roleRef, goodBinding.roleRef);
  assert.deepEqual((api.objects.get(RB) as typeof goodBinding).subjects, goodBinding.subjects);
});

test('ensureAccess on 409 verifies the existing RoleBinding and refuses one that was changed', async () => {
  // Exactly ours: accepted.
  await kubeClient(fakeApi({ [RB]: goodBinding }).call, access).ensureAccess('store-acme');
  const tampered = {
    'another role': { ...goodBinding, roleRef: { ...goodBinding.roleRef, name: 'cluster-admin' } },
    'a Role instead of the ClusterRole': {
      ...goodBinding,
      roleRef: { ...goodBinding.roleRef, kind: 'Role' },
    },
    'an extra subject': {
      ...goodBinding,
      subjects: [
        ...goodBinding.subjects,
        { kind: 'ServiceAccount', name: 'intruder', namespace: 'store-acme' },
      ],
    },
    'a different service account': {
      ...goodBinding,
      subjects: [{ kind: 'ServiceAccount', name: 'store-provisioner', namespace: 'store-acme' }],
    },
  };
  for (const [what, rb] of Object.entries(tampered)) {
    await assert.rejects(
      kubeClient(fakeApi({ [RB]: rb }).call, access).ensureAccess('store-acme'),
      /does not bind ClusterRole platform-store-tenant to platform\/store-provisioner only; refusing/,
      what,
    );
  }
});

test('the only Secret the client can read is the MCP token, by name', async () => {
  const api = fakeApi();
  const kube = kubeClient(api.call, access);
  await kube.createSecret('store-acme', 'store-db', { MARIADB_ROOT_PASSWORD: 'x'.repeat(24) });
  await kube.createSecret('store-acme', 'store-db', { MARIADB_ROOT_PASSWORD: 'other' }); // exists: no overwrite
  await kube.createSecret('store-acme', 'woocommerce-mcp-auth', { MCP_AUTH_TOKEN: 'token-1' });
  assert.equal(await kube.readMcpToken('store-acme'), 'token-1');
  assert.deepEqual(
    api.requests.filter((r) => r.startsWith('GET')),
    ['GET /api/v1/namespaces/store-acme/secrets/woocommerce-mcp-auth'],
  );
  assert.ok(!('getSecret' in kube), 'no general Secret read exists');
});

test('allowed() asks the API server (SelfSubjectAccessReview) with the exact attributes', async () => {
  const bodies: unknown[] = [];
  const kube = kubeClient(async (_m, _p, body) => {
    bodies.push(body);
    return { status: { allowed: true } };
  }, access);
  assert.equal(await kube.allowed({ verb: 'get', resource: 'secrets', namespace: 'platform' }), true);
  assert.deepEqual((bodies[0] as { spec: unknown }).spec, {
    resourceAttributes: { verb: 'get', resource: 'secrets', group: '', namespace: 'platform' },
  });
});

test('the provisioner refuses to start while it holds rights from the old broad RBAC', async () => {
  const holds = (granted: string[]): Kube =>
    ({ allowed: async (c) => granted.includes(`${c.verb} ${c.resource} ${c.namespace ?? '*'}`) }) as Kube;
  // Least-privilege chart: nothing forbidden is granted.
  await assertLeastPrivilege(holds([]), 'platform');
  // The previous chart's ClusterRole: Secrets everywhere, Deployments in kube-system.
  await assert.rejects(
    assertLeastPrivilege(
      holds(['get secrets platform', 'list secrets *', 'create deployments kube-system']),
      'platform',
    ),
    /holds rights it must not have \(get secrets in platform; list secrets in all namespaces; create apps\/deployments in kube-system\)/,
  );
  assert.ok(forbiddenRights('platform').some((c) => c.resource === 'clusterroles'));
});

test('Helm stores releases in ConfigMaps, not Secrets', () => {
  assert.equal(HELM_ENV.HELM_DRIVER, 'configmap');
});
