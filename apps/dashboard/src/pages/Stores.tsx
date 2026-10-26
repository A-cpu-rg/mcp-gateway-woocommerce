import { type FormEvent, useEffect, useRef, useState } from 'react';
import { api, type Me } from '../api.ts';
import { type Poller, poll } from '../poll.ts';

interface Store {
  id: string;
  slug: string;
  name: string;
  owner?: string;
  status: 'provisioning' | 'ready' | 'failed' | 'deleting';
  reason: string | null;
  url: string;
  tools: string;
  createdAt: string;
  readyAt: string | null;
}

const LABEL: Record<Store['status'], string> = {
  provisioning: 'Provisioning',
  ready: 'Ready',
  failed: 'Failed',
  deleting: 'Deleting',
};
// Reuses the server status badge colours.
const BADGE: Record<Store['status'], string> = {
  provisioning: 'unknown',
  ready: 'connected',
  failed: 'unreachable',
  deleting: 'disabled',
};

export function Stores({ me }: { me: Me }) {
  const [stores, setStores] = useState<Store[]>([]);
  const [error, setError] = useState('');

  const poller = useRef<Poller | null>(null);
  useEffect(() => {
    const p = poll(
      (signal) => api<Store[]>('/stores', 'GET', undefined, signal),
      setStores,
      (e) => setError(e.message),
      5000,
    );
    poller.current = p;
    return () => p.stop();
  }, []);
  const load = () => poller.current?.refresh();

  async function act(fn: () => Promise<unknown>) {
    setError('');
    try {
      await fn();
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    void act(async () => {
      await api('/stores', 'POST', { name: f.get('name'), slug: f.get('slug') });
      form.reset();
    });
  }

  return (
    <section>
      <h2>Stores</h2>
      <p className="muted">
        Each store gets its own namespace, database, volumes and URL, and its own WooCommerce MCP server,
        registered in the gateway as <code>store-&lt;slug&gt;</code>. Provisioning takes a few minutes.
      </p>
      <form className="row" onSubmit={create}>
        <input name="name" aria-label="Store name" placeholder="Store name" required maxLength={80} />
        <input
          name="slug"
          aria-label="Store slug"
          placeholder="slug, e.g. acme"
          required
          pattern="[a-z][a-z0-9\-]{1,17}"
          title="lowercase letters, digits and -, 2-18 characters"
        />
        <button type="submit">Create store</button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <table>
        <caption className="sr-only">Stores</caption>
        <thead>
          <tr>
            <th>Store</th>
            {me.role === 'admin' && <th>Owner</th>}
            <th>Status</th>
            <th>URL</th>
            <th>Tools</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {stores.map((s) => (
            <tr key={s.id}>
              <td>
                {s.name} <code className="muted">{s.slug}</code>
              </td>
              {me.role === 'admin' && <td>{s.owner}</td>}
              <td>
                <span className={`badge ${BADGE[s.status]}`}>{LABEL[s.status]}</span>
                {s.reason && <div className={s.status === 'failed' ? 'error' : 'muted'}>{s.reason}</div>}
              </td>
              <td>
                {s.status === 'ready' ? (
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.url}
                  </a>
                ) : (
                  <span className="muted">{s.url}</span>
                )}
              </td>
              <td>
                <code>{s.tools}</code>
              </td>
              <td>{new Date(s.createdAt).toLocaleString()}</td>
              <td className="actions">
                {s.status === 'failed' && (
                  <button type="button" onClick={() => act(() => api(`/stores/${s.id}/retry`, 'POST'))}>
                    Retry
                  </button>
                )}
                {s.status !== 'deleting' && (
                  <button
                    type="button"
                    className="danger"
                    onClick={() =>
                      confirm(`Delete ${s.name}? Its database, files and MCP server are removed.`) &&
                      act(() => api(`/stores/${s.id}`, 'DELETE'))
                    }
                  >
                    Delete
                  </button>
                )}
              </td>
            </tr>
          ))}
          {stores.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                No stores yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
