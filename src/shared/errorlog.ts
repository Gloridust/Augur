// Persistent error ring-buffer. Until now every failure was a console.error
// that vanished on the next service-worker restart, so the debug bundle (the
// only artifact we get from a real user) carried no diagnostics at all — the
// "document is not defined" SW crashes took several releases to find precisely
// because the swallowing try/catch left no trace. This captures the last N
// errors into db.kv so they ride along in the exported bundle (errors.json).
//
// Deliberately dependency-light (only db) so it's safe to import from the
// service worker, the ML modules, and data-ops without any circular-import or
// dynamic-import-in-SW risk. Every function is best-effort and never throws —
// an error logger that can itself crash is worse than useless.

import { db } from './db';

const ERROR_LOG_KEY = 'errorLog:v1';
const MAX_ENTRIES = 200;

export interface ErrorEntry {
  ts: number;
  context: string; // where it happened, e.g. 'sw.onerror', 'mlp.trainSave'
  message: string;
  stack?: string;
}

export async function logError(context: string, err: unknown): Promise<void> {
  // Always surface to the live console too — helps when devtools is open.
  try {
    console.error(`[augur] ${context}`, err);
  } catch {
    /* ignore */
  }
  try {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    const row = await db.kv.get(ERROR_LOG_KEY);
    const list: ErrorEntry[] = Array.isArray(row?.value) ? (row!.value as ErrorEntry[]) : [];
    list.push({ ts: Date.now(), context, message, stack });
    await db.kv.put({
      key: ERROR_LOG_KEY,
      value: list.slice(-MAX_ENTRIES),
      updatedAt: Date.now(),
    });
  } catch {
    // Never throw from the error logger.
  }
}

export async function loadErrorLog(): Promise<ErrorEntry[]> {
  try {
    const row = await db.kv.get(ERROR_LOG_KEY);
    return Array.isArray(row?.value) ? (row!.value as ErrorEntry[]) : [];
  } catch {
    return [];
  }
}

export async function clearErrorLog(): Promise<void> {
  try {
    await db.kv.delete(ERROR_LOG_KEY);
  } catch {
    /* ignore */
  }
}
