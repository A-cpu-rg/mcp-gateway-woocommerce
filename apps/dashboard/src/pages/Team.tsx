import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, type Me } from '../api.ts';

interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  active: boolean;
  disabledAt: string | null;
}

export function Team({ me }: { me: Me }) {
  const [users, setUsers] = useState<User[]>([]);
  const [inviteUrl, setInviteUrl] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<User[]>('/users')
      .then(setUsers)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    try {
      const res = await api<{ inviteUrl: string }>('/invites', 'POST', {
        email: f.get('email'),
        name: f.get('name'),
        role: f.get('role'),
      });
      setInviteUrl(res.inviteUrl);
      form.reset();
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function update(u: User, change: { role?: string; disabled?: boolean }) {
    try {
      await api(`/users/${u.id}`, 'PATCH', change);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section>
      <h2>Team</h2>
      <form className="row" onSubmit={invite}>
        <input name="name" placeholder="Name" required />
        <input name="email" type="email" placeholder="Email" required />
        <select name="role" defaultValue="member">
          <option value="member">Member (uses tools)</option>
          <option value="admin">Admin (manages servers and members)</option>
        </select>
        <button type="submit">Invite</button>
      </form>
      {inviteUrl && (
        <div className="card highlight">
          <p>Send this one-time link to the new member (valid 72 hours):</p>
          <pre>{inviteUrl}</pre>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>
                <select
                  value={u.role}
                  disabled={u.id === me.userId}
                  onChange={(e) => update(u, { role: e.target.value })}
                >
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </select>
              </td>
              <td>{u.disabledAt ? 'Disabled' : u.active ? 'Active' : 'Invited'}</td>
              <td>
                {u.id !== me.userId && (
                  <button type="button" onClick={() => update(u, { disabled: !u.disabledAt })}>
                    {u.disabledAt ? 'Enable' : 'Disable'}
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
