import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, type Me } from '../api.ts';

interface Key {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  userEmail: string;
}

interface TeamUser {
  id: string;
  email: string;
  disabledAt: string | null;
}

export function Keys({ me }: { me: Me }) {
  const [keys, setKeys] = useState<Key[]>([]);
  const [all, setAll] = useState(false);
  const [created, setCreated] = useState<{ token: string; mcpUrl: string; owner: string } | null>(null);
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [error, setError] = useState('');
  const isAdmin = me.role === 'admin';

  // Admins can issue a key for a team member (the key acts and is audited as that member).
  useEffect(() => {
    if (!isAdmin) return;
    api<TeamUser[]>('/users')
      .then((list) => setUsers(list.filter((u) => !u.disabledAt)))
      .catch((e) => setError(e.message));
  }, [isAdmin]);

  const load = useCallback(() => {
    api<Key[]>(`/keys${all ? '?all=1' : ''}`)
      .then(setKeys)
      .catch((e) => setError(e.message));
  }, [all]);
  useEffect(load, [load]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const userId = String(f.get('userId') ?? '') || undefined;
    try {
      const key = await api<{ token: string; mcpUrl: string }>('/keys', 'POST', {
        name: f.get('name'),
        userId,
      });
      setCreated({ ...key, owner: users.find((u) => u.id === userId)?.email ?? me.email });
      form.reset();
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function revoke(k: Key) {
    if (!confirm(`Revoke "${k.name}" (${k.userEmail})? Clients using it stop working immediately.`)) return;
    try {
      await api(`/keys/${k.id}`, 'DELETE');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section>
      <h2>API keys</h2>
      <p className="muted">
        A key lets an MCP client (Claude Code, Cursor, MCP Inspector) use every enabled server through the
        gateway as you. Upstream credentials stay on the server.
      </p>
      <form className="row" onSubmit={create}>
        <input
          name="name"
          aria-label="Key name"
          placeholder="Key name, e.g. laptop"
          required
          maxLength={80}
        />
        {isAdmin && users.length > 0 && (
          <label className="inline">
            For{' '}
            <select name="userId" defaultValue="">
              <option value="">me ({me.email})</option>
              {users
                .filter((u) => u.email !== me.email)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.email}
                  </option>
                ))}
            </select>
          </label>
        )}
        <button type="submit">Generate key</button>
      </form>
      {created && (
        <div className="card highlight">
          <p>
            <strong>Copy this key now — it will not be shown again.</strong>
            {created.owner !== me.email && (
              <>
                {' '}
                It belongs to <strong>{created.owner}</strong>: hand it over privately (not in a shared chat).
              </>
            )}
          </p>
          <pre>{created.token}</pre>
          <p>Claude Code:</p>
          <pre>{`claude mcp add --transport http urumi-gateway ${created.mcpUrl} \\\n  --header "Authorization: Bearer ${created.token}"`}</pre>
          <p>Cursor / other clients (mcp.json):</p>
          <pre>
            {JSON.stringify(
              {
                mcpServers: {
                  'urumi-gateway': {
                    url: created.mcpUrl,
                    headers: { Authorization: `Bearer ${created.token}` },
                  },
                },
              },
              null,
              2,
            )}
          </pre>
          <button type="button" onClick={() => setCreated(null)}>
            Done
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {isAdmin && (
        <label className="inline">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show all team
          keys
        </label>
      )}
      <table>
        <caption className="sr-only">API keys</caption>
        <thead>
          <tr>
            <th>Name</th>
            <th>Owner</th>
            <th>Created</th>
            <th>Last used</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id}>
              <td>
                {k.name} <code className="muted">mgw_{k.id}_…</code>
              </td>
              <td>{k.userEmail}</td>
              <td>{new Date(k.createdAt).toLocaleString()}</td>
              <td>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : '—'}</td>
              <td>
                {k.revokedAt ? (
                  <span className="badge unreachable">Revoked</span>
                ) : (
                  <span className="badge connected">Active</span>
                )}
              </td>
              <td>
                {!k.revokedAt && (
                  <button type="button" className="danger" onClick={() => revoke(k)}>
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
