// Serial event queue for the service worker.
//
// Chrome dispatches extension events back-to-back without waiting for async
// listeners, so two handlers that each "read state → await → write state"
// interleave. That was the root of a whole class of data-corruption bugs in
// the July 2026 trace: 22% of navigate events were duplicates (the onUpdated
// URL fast-path and the status==='complete' path both saw the old URL),
// onActivated + windows.onFocusChanged double-logged focus/blur (≈1.5h of
// focus time counted twice), and title updates could clobber a concurrent
// focusedAt write.
//
// Every listener body runs through `enqueue`, so handlers execute strictly
// one after another in arrival order and each sees the state the previous
// one left behind. Listener *registration* stays synchronous at the top level
// (an MV3 requirement); only the body is deferred onto the chain.
//
// A task must never `await enqueue(...)` from inside another task — that
// would deadlock the chain. Handlers call plain async functions instead.

import { logError } from '../shared/errorlog';

let tail: Promise<unknown> = Promise.resolve();

export function enqueue<T>(label: string, task: () => Promise<T>): Promise<T | undefined> {
  const run = tail.then(async () => {
    try {
      return await task();
    } catch (err) {
      void logError(`queue.${label}`, err);
      return undefined;
    }
  });
  tail = run;
  return run;
}

// Resolves once the chain is empty, including tasks enqueued while draining.
export async function whenIdle(): Promise<void> {
  let seen: Promise<unknown>;
  do {
    seen = tail;
    await seen;
  } while (seen !== tail);
}
