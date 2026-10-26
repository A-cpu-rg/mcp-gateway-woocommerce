// Polling without stale results. Each load gets an AbortSignal; starting a newer load (a poll tick, a refresh
// after an action, a filter change) aborts the older one, and only the newest load's result or error is
// applied, so a slow earlier response can never overwrite a fresher one. Nothing is applied after stop()
// (page unmounted or logged out).

export interface Poller {
  /** Load now (e.g. after an action), superseding any load in flight. */
  refresh(): void;
  stop(): void;
}

export function poll<T>(
  load: (signal: AbortSignal) => Promise<T>,
  apply: (value: T) => void,
  fail: (err: Error) => void,
  everyMs: number,
): Poller {
  let seq = 0;
  let controller: AbortController | undefined;
  let stopped = false;
  const refresh = () => {
    if (stopped) return;
    const mine = ++seq;
    controller?.abort();
    const c = new AbortController();
    controller = c;
    load(c.signal).then(
      (value) => {
        if (!stopped && mine === seq) apply(value);
      },
      (err: Error) => {
        if (!stopped && mine === seq && !c.signal.aborted) fail(err);
      },
    );
  };
  refresh();
  const timer = setInterval(refresh, everyMs);
  return {
    refresh,
    stop() {
      stopped = true;
      clearInterval(timer);
      controller?.abort();
    },
  };
}
