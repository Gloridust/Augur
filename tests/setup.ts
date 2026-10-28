// Global test setup: a real (in-memory) IndexedDB for Dexie and a fresh
// chrome.* mock. Tests that need a pristine world call `freshWorld()` from
// ./harness, which swaps both and re-imports the modules under test.
import 'fake-indexeddb/auto';
import { createChromeMock } from './chrome-mock';

(globalThis as { chrome?: unknown }).chrome = createChromeMock().chrome;

// The service worker registers global error handlers on `self`.
(globalThis as { self?: unknown }).self ??= {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};
