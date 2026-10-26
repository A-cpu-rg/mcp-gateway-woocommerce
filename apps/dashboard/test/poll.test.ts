import assert from 'node:assert/strict';
import { test } from 'node:test';
import { poll } from '../src/poll.ts';

// Controllable loads: each call returns a promise the test resolves or rejects later, in any order.
function loads<T>() {
  const pending: { resolve: (v: T) => void; reject: (e: Error) => void; signal: AbortSignal }[] = [];
  const load = (signal: AbortSignal) =>
    new Promise<T>((resolve, reject) => {
      pending.push({ resolve, reject, signal });
    });
  return { load, pending };
}
const tick = () => new Promise((r) => setImmediate(r));

test('out-of-order responses: the newest load wins, a slow older one is discarded', async (t) => {
  const { load, pending } = loads<string>();
  const applied: string[] = [];
  const p = poll(
    load,
    (v) => applied.push(v),
    () => {},
    1e9,
  );
  t.after(() => p.stop());
  p.refresh(); // e.g. a filter change or an action while the first request is still in flight
  assert.equal(pending.length, 2);
  assert.equal(pending[0]?.signal.aborted, true, 'the older request is aborted');
  pending[1]?.resolve('new');
  await tick();
  pending[0]?.resolve('old'); // arrives last
  await tick();
  assert.deepEqual(applied, ['new']);
  p.stop();
});

test('an aborted or superseded load never reports an error', async (t) => {
  const { load, pending } = loads<string>();
  const errors: string[] = [];
  const p = poll(
    load,
    () => {},
    (e) => errors.push(e.message),
    1e9,
  );
  t.after(() => p.stop());
  p.refresh();
  pending[0]?.reject(new Error('AbortError'));
  pending[1]?.reject(new Error('HTTP 500'));
  await tick();
  assert.deepEqual(errors, ['HTTP 500'], 'only the current load can report');
  p.stop();
});

test('after stop (unmount, logout) nothing is applied and the request in flight is aborted', async () => {
  const { load, pending } = loads<string>();
  const applied: string[] = [];
  const errors: string[] = [];
  const p = poll(
    load,
    (v) => applied.push(v),
    (e) => errors.push(e.message),
    1e9,
  );
  p.stop();
  assert.equal(pending[0]?.signal.aborted, true);
  pending[0]?.resolve('late');
  await tick();
  p.refresh();
  assert.equal(pending.length, 1, 'no load after stop');
  assert.deepEqual([applied, errors], [[], []]);
});

test('polls on its interval', async (t) => {
  let n = 0;
  const p = poll(
    async () => ++n,
    () => {},
    () => {},
    10,
  );
  t.after(() => p.stop());
  await new Promise((r) => setTimeout(r, 55));
  p.stop();
  assert.ok(n >= 3, `loaded ${n} times`);
});
