import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, type Me, type Server } from '../api.ts';

const STATUS_LABEL: Record<Server['status'], string> = {
  connected: 'Connected',
  unreachable: 'Unreachable',
  disabled: 'Disabled',
  unknown: 'Checking…',
};

export function Servers({ me }: { me: Me }) {
  const [servers, setServers] = useState<Server[]>([]);
  const [editing, setEditing] = useState<Server | 'new' | null>(null);
  const [error, setError] = useState('');
  const isAdmin = me.role === 'admin';

  const load = useCallback(() => {
    api<Server[]>('/servers')
      .then(setServers)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setError('');
    try {
      await fn();
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const toggle = (s: Server) =>
    act(() => api(`/servers/${s.id}`, 'PUT', { ...formValues(s), enabled: !s.enabled }));

  return (
    <section>
      <div className="row">
        <h2>MCP servers</h2>
        {isAdmin && (
          <button type="button" onClick={() => setEditing('new')}>
            Add server
          </button>
        )}
      </div>
      <p className="muted">
        One endpoint for every enabled server: <code>{me.mcpUrl}</code>
      </p>
      {error && <p className="error">{error}</p>}
      {editing && (
        <ServerForm
          server={editing === 'new' ? undefined : editing}
          onDone={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {servers.map((s) => (
        <article key={s.id} className="card">
          <div className="row">
            <h3>
              {s.name} <code>{s.slug}</code>
            </h3>
            <span className={`badge ${s.status}`}>{STATUS_LABEL[s.status]}</span>
          </div>
          {s.url && <p className="muted">{s.url}</p>}
          {s.status === 'unreachable' && s.lastError && <p className="error">Reason: {s.lastError}</p>}
          {isAdmin && (
            <div className="actions">
              <button type="button" onClick={() => setEditing(s)}>
                Edit
              </button>
              <button type="button" onClick={() => toggle(s)}>
                {s.enabled ? 'Disable' : 'Enable'}
              </button>
              <button type="button" onClick={() => act(() => api(`/servers/${s.id}/refresh`, 'POST'))}>
                Check now
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => confirm(`Remove ${s.name}?`) && act(() => api(`/servers/${s.id}`, 'DELETE'))}
              >
                Remove
              </button>
            </div>
          )}
          <details open={s.tools.length <= 8}>
            <summary>{s.tools.length} tools</summary>
            <ul className="tools">
              {s.tools.map((t) => (
                <li key={t.exposedName}>
                  <code>{t.exposedName}</code>
                  {t.adminOnly && <span className="badge small">admin only</span>}
                  {t.readOnly && <span className="badge small ro">read-only</span>}
                  <span className="muted"> {t.description}</span>
                </li>
              ))}
            </ul>
          </details>
        </article>
      ))}
    </section>
  );
}

function formValues(s: Server) {
  return {
    slug: s.slug,
    name: s.name,
    url: s.url,
    enabled: s.enabled,
    authType: s.authType,
    authHeader: s.authHeader,
    timeoutMs: s.timeoutMs,
    adminOnlyTools: s.adminOnlyTools ?? [],
  };
}

function ServerForm({ server, onDone }: { server?: Server; onDone: () => void }) {
  const [authType, setAuthType] = useState(server?.authType ?? 'none');
  const [error, setError] = useState('');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const credential = String(f.get('credential') ?? '');
    const body = {
      slug: f.get('slug'),
      name: f.get('name'),
      url: f.get('url'),
      enabled: server?.enabled ?? true,
      authType,
      authHeader: authType === 'header' ? f.get('authHeader') : null,
      // Empty field on edit = keep the stored credential (it is never sent back to the browser).
      ...(credential ? { credential } : authType === 'none' ? { credential: null } : {}),
      timeoutMs: Number(f.get('timeoutMs')),
      adminOnlyTools: f.getAll('adminOnly').map(String),
    };
    try {
      await (server ? api(`/servers/${server.id}`, 'PUT', body) : api('/servers', 'POST', body));
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form className="card form" onSubmit={submit}>
      <h3>{server ? `Edit ${server.name}` : 'Add MCP server'}</h3>
      <label>
        Name <input name="name" defaultValue={server?.name} required maxLength={80} />
      </label>
      <label>
        Slug (tool prefix){' '}
        <input name="slug" defaultValue={server?.slug} required pattern="[a-z0-9][a-z0-9-]{0,23}" />
      </label>
      <label>
        Streamable HTTP URL <input name="url" type="url" defaultValue={server?.url} required />
      </label>
      <label>
        Credential type
        <select value={authType} onChange={(e) => setAuthType(e.target.value as typeof authType)}>
          <option value="none">None</option>
          <option value="bearer">Bearer token</option>
          <option value="header">Custom header</option>
        </select>
      </label>
      {authType === 'header' && (
        <label>
          Header name <input name="authHeader" defaultValue={server?.authHeader ?? ''} required />
        </label>
      )}
      {authType !== 'none' && (
        <label>
          Credential{' '}
          <input
            name="credential"
            type="password"
            autoComplete="off"
            placeholder={server?.hasCredential ? 'stored — leave empty to keep' : ''}
            required={!server?.hasCredential}
          />
        </label>
      )}
      <label>
        Timeout (ms){' '}
        <input
          name="timeoutMs"
          type="number"
          min={1000}
          max={60000}
          defaultValue={server?.timeoutMs ?? 10000}
        />
      </label>
      {server && server.tools.length > 0 && (
        <fieldset>
          <legend>Admin-only tools (hidden from members and rejected if called)</legend>
          {server.tools.map((t) => (
            <label key={t.name} className="inline">
              <input type="checkbox" name="adminOnly" value={t.name} defaultChecked={t.adminOnly} /> {t.name}
            </label>
          ))}
        </fieldset>
      )}
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="submit">Save</button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
