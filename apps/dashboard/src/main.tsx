import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, type Me } from './api.ts';
import { Audit } from './pages/Audit.tsx';
import { Chat } from './pages/Chat.tsx';
import { Keys } from './pages/Keys.tsx';
import { Invite, Login } from './pages/Login.tsx';
import { Servers } from './pages/Servers.tsx';
import { Stores } from './pages/Stores.tsx';
import { Team } from './pages/Team.tsx';
import './styles.css';

const TABS = ['servers', 'stores', 'chat', 'keys', 'audit', 'team'] as const;
type Tab = (typeof TABS)[number];

function useHash(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
}

function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const hash = useHash();
  const load = useCallback(() => {
    api<Me>('/me')
      .then(setMe)
      .catch(() => setMe(null));
  }, []);
  useEffect(load, [load]);

  const invite = /^#\/invite\/(.+)$/.exec(hash);
  if (invite) return <Invite token={invite[1] as string} />;
  if (me === undefined) return <p className="center">Loading…</p>;
  if (me === null) return <Login onLogin={load} />;

  const tab = (TABS.find((t) => hash === `#/${t}`) ?? 'servers') as Tab;
  const visible = TABS.filter(
    (t) => (t !== 'team' || me.role === 'admin') && (t !== 'stores' || me.storesEnabled),
  );
  return (
    <div className="layout">
      <header>
        <strong>MCP Gateway</strong>
        <nav>
          {visible.map((t) => (
            <a key={t} href={`#/${t}`} className={t === tab ? 'active' : ''}>
              {t[0]?.toUpperCase() + t.slice(1)}
            </a>
          ))}
        </nav>
        <span className="muted">
          {me.email} · {me.role}{' '}
          <button
            type="button"
            className="link"
            onClick={() => api('/auth/logout', 'POST').finally(() => setMe(null))}
          >
            Log out
          </button>
        </span>
      </header>
      <main>
        {tab === 'servers' && <Servers me={me} />}
        {tab === 'stores' && me.storesEnabled && <Stores me={me} />}
        {tab === 'chat' && <Chat me={me} />}
        {tab === 'keys' && <Keys me={me} />}
        {tab === 'audit' && <Audit me={me} />}
        {tab === 'team' && me.role === 'admin' && <Team me={me} />}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
