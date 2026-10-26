import { type FormEvent, useState } from 'react';
import { type ChatEvent, chat, type Me } from '../api.ts';

type Turn =
  | { kind: 'user'; content: string }
  | { kind: 'assistant'; content: string }
  | { kind: 'tool'; name: string; args: unknown; ok?: boolean; preview?: string; id: string }
  | { kind: 'error'; content: string };

export function Chat({ me }: { me: Me }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);

  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const text = String(new FormData(form).get('q') ?? '').trim();
    if (!text || busy) return;
    form.reset();
    const next: Turn[] = [...turns, { kind: 'user', content: text }];
    setTurns(next);
    setBusy(true);
    // Only the text conversation is sent back; tool traffic is re-derived server-side each turn.
    const history = next
      .filter(
        (t): t is Extract<Turn, { kind: 'user' | 'assistant' }> =>
          t.kind === 'user' || t.kind === 'assistant',
      )
      .map((t) => ({ role: t.kind, content: t.content }));
    const onEvent = (ev: ChatEvent) =>
      setTurns((prev) => {
        if (ev.type === 'tool_call')
          return [...prev, { kind: 'tool', id: ev.id, name: ev.name, args: ev.arguments }];
        if (ev.type === 'tool_result') {
          return prev.map((t) =>
            t.kind === 'tool' && t.id === ev.id ? { ...t, ok: ev.ok, preview: ev.preview } : t,
          );
        }
        if (ev.type === 'message') return [...prev, { kind: 'assistant', content: ev.content }];
        return [...prev, { kind: 'error', content: ev.message }];
      });
    try {
      await chat(history, onEvent);
    } catch (err) {
      setTurns((prev) => [...prev, { kind: 'error', content: (err as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  if (!me.chatEnabled) {
    return <p className="card">Chat is disabled: no LLM is configured on the gateway (LLM_API_KEY).</p>;
  }
  return (
    <section className="chat">
      <h2>Chat agent</h2>
      <p className="muted">
        Answers with the same gateway tools you can use, as {me.email}. Every tool call appears in the audit
        log.
      </p>
      <div className="transcript" role="log" aria-live="polite" aria-label="Conversation">
        {turns.map((t, i) => {
          const key = `${t.kind}-${i}`;
          if (t.kind === 'tool') {
            return (
              <details key={key} className={`tool-call ${t.ok === false ? 'failed' : ''}`}>
                <summary>
                  {t.ok === undefined ? '⏳' : t.ok ? '✓' : '✗'} called <code>{t.name}</code>
                </summary>
                <pre>{JSON.stringify(t.args, null, 2)}</pre>
                {t.preview && <pre className="muted">{t.preview}</pre>}
              </details>
            );
          }
          return (
            <div key={key} className={`msg ${t.kind}`}>
              {t.content}
            </div>
          );
        })}
        {busy && <div className="muted">Thinking…</div>}
      </div>
      <form className="row" onSubmit={send}>
        <input
          name="q"
          aria-label="Ask the agent"
          placeholder="e.g. What orders came in today?"
          autoComplete="off"
          disabled={busy}
        />
        <button type="submit" disabled={busy}>
          Send
        </button>
      </form>
    </section>
  );
}
