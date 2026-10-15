import { type FormEvent, useState } from 'react';
import { api } from '../api.ts';

export function Login({ onLogin }: { onLogin: () => void }) {
  const [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api('/auth/login', 'POST', { email: f.get('email'), password: f.get('password') });
      onLogin();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <form className="card narrow" onSubmit={submit}>
      <h1>MCP Gateway</h1>
      <label>
        Email <input name="email" type="email" required autoComplete="username" />
      </label>
      <label>
        Password <input name="password" type="password" required autoComplete="current-password" />
      </label>
      {error && <p className="error">{error}</p>}
      <button type="submit">Log in</button>
    </form>
  );
}

export function Invite({ token }: { token: string }) {
  const [state, setState] = useState<'form' | 'done'>('form');
  const [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = new FormData(e.currentTarget).get('password');
    try {
      await api('/invites/accept', 'POST', { token, password });
      setState('done');
    } catch (err) {
      setError((err as Error).message);
    }
  }
  if (state === 'done') {
    return (
      <div className="card narrow">
        <h1>Welcome</h1>
        <p>Your account is ready.</p>
        <a href="#/servers">Log in</a>
      </div>
    );
  }
  return (
    <form className="card narrow" onSubmit={submit}>
      <h1>Accept invite</h1>
      <label>
        Choose a password (min. 10 characters)
        <input name="password" type="password" minLength={10} required autoComplete="new-password" />
      </label>
      {error && <p className="error">{error}</p>}
      <button type="submit">Create account</button>
    </form>
  );
}
