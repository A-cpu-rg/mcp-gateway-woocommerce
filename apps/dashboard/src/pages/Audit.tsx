import { useCallback, useEffect, useState } from 'react';
import { api, type Me } from '../api.ts';

interface Row {
  id: number;
  at: string;
  user: string;
  apiKeyId: string | null;
  channel: 'mcp' | 'chat';
  server: string | null;
  tool: string | null;
  durationMs: number;
  outcome: string;
  error: string | null;
}

const OUTCOMES = [
  '',
  'ok',
  'tool_error',
  'upstream_error',
  'timeout',
  'denied',
  'not_found',
  'auth_rejected',
  'busy',
  'pending', // in flight, or the gateway stopped mid-call (outcome unknown)
];

export function Audit({ me }: { me: Me }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [outcome, setOutcome] = useState('');
  const [server, setServer] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (outcome) q.set('outcome', outcome);
    if (server) q.set('server', server);
    api<Row[]>(`/audit?${q}`)
      .then(setRows)
      .catch((e) => setError(e.message));
  }, [outcome, server]);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <section>
      <h2>Audit log</h2>
      <p className="muted">
        Every tool call through the gateway, from MCP clients and the chat agent.
        {me.role !== 'admin' && ' You see your own calls.'}
      </p>
      <div className="row">
        <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {o || 'all outcomes'}
            </option>
          ))}
        </select>
        <input placeholder="server slug" value={server} onChange={(e) => setServer(e.target.value.trim())} />
      </div>
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>User</th>
            <th>Via</th>
            <th>Server</th>
            <th>Tool</th>
            <th>Duration</th>
            <th>Outcome</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} title={r.error ?? ''}>
              <td>{new Date(r.at).toLocaleString()}</td>
              <td>{r.user}</td>
              <td>{r.channel === 'chat' ? 'chat' : `key ${r.apiKeyId ?? ''}`}</td>
              <td>{r.server ?? '—'}</td>
              <td>
                <code>{r.tool ?? '—'}</code>
              </td>
              <td>{r.durationMs} ms</td>
              <td>
                <span className={`badge ${r.outcome === 'ok' ? 'connected' : 'unreachable'}`}>
                  {r.outcome}
                </span>
                {r.error && <div className="muted small">{r.error}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
