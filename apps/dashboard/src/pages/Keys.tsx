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

export function Keys({ me }: { me: Me }) {
  const [keys, setKeys] = useState<Key[]>([]);
  const [all, setAll] = useState(false);
  const [created, setCreated] = useState<{ token: string; mcpUrl: string } | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<Key[]>(`/keys${all ? '?all=1' : ''}`)
      .then(setKeys)
      .catch((e) => setError(e.message));
  }, [all]);
  useEffect(load, [load]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      setCreated(await api('/keys', 'POST', { name: new FormData(form).get('name') }));
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
        <input name="name" placeholder="Key name, e.g. laptop" required maxLength={80} />
        <button type="submit">Generate key</button>
      </form>
      {created && (
        <div className="card highlight">
          <p>
            <strong>Copy this key now — it will not be shown again.</strong>
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
      {error && <p className="error">{error}</p>}
      {me.role === 'admin' && (
        <label className="inline">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show all team
          keys
        </label>
      )}
      <table>
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
