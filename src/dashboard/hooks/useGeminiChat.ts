import { useCallback, useEffect, useRef, useState } from 'react';

// Wraps Chrome's built-in Prompt API (`window.LanguageModel`, Chrome 138+ for
// extensions). Talks to on-device Gemini Nano — no key, no network.
//
// State (messages + last-activity timestamp) lives in `chrome.storage.session`
// so the conversation is shared across every dashboard tab in the same
// browser session. Each tab subscribes via `chrome.storage.onChanged` and
// keeps its local state in sync. The LanguageModel session itself is
// per-tab (Chrome doesn't expose a way to share it), so when a tab needs
// to talk it seeds a fresh session with the existing message history as
// `initialPrompts` — that gives every tab the same conversational context.
//
// Idle clear: each tab schedules a setTimeout for `lastActivity + 30min`.
// Whichever tab fires first writes empty messages back to storage, which
// the others pick up via the subscription.

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface LMSession {
  prompt(input: string, opts?: { signal?: AbortSignal }): Promise<string>;
  promptStreaming(input: string, opts?: { signal?: AbortSignal }): ReadableStream<string>;
  destroy(): void;
  inputUsage?: number;
  inputQuota?: number;
}

interface LMConstructor {
  availability(opts?: unknown): Promise<Availability>;
  create(opts?: {
    initialPrompts?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    monitor?: (m: EventTarget) => void;
    signal?: AbortSignal;
    temperature?: number;
    topK?: number;
  }): Promise<LMSession>;
}

declare global {
  interface Window {
    LanguageModel?: LMConstructor;
  }
}

export type ChatRole = 'user' | 'assistant';
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  streaming?: boolean;
}

export type ChatStatus =
  | 'unsupported'
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available'
  | 'checking';

const IDLE_CLEAR_MS = 30 * 60 * 1_000;
const STREAM_FLUSH_MS = 250;

const STORAGE_KEY_MESSAGES = 'augur:ai:messages';
const STORAGE_KEY_LAST_ACTIVITY = 'augur:ai:lastActivity';
const STORAGE_KEY_STOP_SIGNAL = 'augur:ai:stopSignal';

const SYSTEM_PROMPT = [
  "You are Augur, the on-device assistant inside the user's new tab page.",
  'Be concise and warm. Aim for short answers (≤3 short paragraphs) unless the user asks for detail.',
  'Reply in the same language the user wrote in.',
  'You run entirely on-device via Gemini Nano — no internet, no logs leave the browser. If the user asks for live information you cannot have, say so plainly.',
].join(' ');

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readStorage<T>(key: string, fallback: T): Promise<T> {
  try {
    const result = await chrome.storage.session.get(key);
    return (result?.[key] as T) ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeStorage(updates: Record<string, unknown>) {
  try {
    await chrome.storage.session.set(updates);
  } catch {
    // ignore
  }
}

export function useGeminiChat() {
  const [status, setStatus] = useState<ChatStatus>('checking');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<LMSession | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  // Mirrors `messages` for use inside async callbacks where reading state
  // through the closure would give a stale value.
  const messagesRef = useRef<ChatMessage[]>([]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // ── 1. Probe LanguageModel availability ──────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (typeof window === 'undefined' || !window.LanguageModel) {
      setStatus('unsupported');
      return;
    }
    void window.LanguageModel
      .availability()
      .then((a) => {
        if (cancelled) return;
        setStatus(a);
      })
      .catch(() => {
        if (!cancelled) setStatus('unsupported');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const scheduleIdleClear = useCallback((lastActivityTs: number) => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
    }
    const delay = Math.max(0, lastActivityTs + IDLE_CLEAR_MS - Date.now());
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      void writeStorage({
        [STORAGE_KEY_MESSAGES]: [],
        [STORAGE_KEY_LAST_ACTIVITY]: null,
      });
    }, delay);
  }, []);

  // ── 2. Hydrate from chrome.storage.session on mount ──────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await readStorage<ChatMessage[]>(STORAGE_KEY_MESSAGES, []);
      const lastActivity = await readStorage<number | null>(STORAGE_KEY_LAST_ACTIVITY, null);
      if (cancelled) return;

      if (lastActivity !== null && Date.now() - lastActivity > IDLE_CLEAR_MS) {
        // Conversation aged out before we mounted — wipe it.
        await writeStorage({
          [STORAGE_KEY_MESSAGES]: [],
          [STORAGE_KEY_LAST_ACTIVITY]: null,
        });
        setMessages([]);
        return;
      }

      // A previous tab may have crashed mid-stream, leaving streaming=true
      // on a message. Clear those flags on hydration so the UI doesn't
      // pretend to be streaming forever.
      setMessages(stored.map((m) => ({ ...m, streaming: false })));
      if (lastActivity !== null) scheduleIdleClear(lastActivity);
    })();
    return () => {
      cancelled = true;
    };
  }, [scheduleIdleClear]);

  // ── 3. Subscribe to cross-tab storage changes ────────────────────────
  useEffect(() => {
    if (!chrome.storage?.onChanged) return;
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName,
    ) => {
      if (area !== 'session') return;
      if (STORAGE_KEY_MESSAGES in changes) {
        const next = (changes[STORAGE_KEY_MESSAGES].newValue as ChatMessage[] | undefined) ?? [];
        setMessages(next);
      }
      if (STORAGE_KEY_LAST_ACTIVITY in changes) {
        const ts = changes[STORAGE_KEY_LAST_ACTIVITY].newValue as number | null | undefined;
        if (typeof ts === 'number') scheduleIdleClear(ts);
      }
      if (STORAGE_KEY_STOP_SIGNAL in changes) {
        // Another tab asked us to stop our local stream.
        abortRef.current?.abort();
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [scheduleIdleClear]);

  // ── 4. Drop the local LM session whenever the conversation is empty ──
  useEffect(() => {
    if (messages.length === 0) {
      abortRef.current?.abort();
      try {
        sessionRef.current?.destroy();
      } catch {
        // session may already be torn down
      }
      sessionRef.current = null;
    }
  }, [messages]);

  // ── 5. Cleanup on unmount ────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
      }
      abortRef.current?.abort();
      try {
        sessionRef.current?.destroy();
      } catch {
        // ignore
      }
    };
  }, []);

  const ensureSession = useCallback(async (): Promise<LMSession | null> => {
    if (sessionRef.current) return sessionRef.current;
    const LM = window.LanguageModel;
    if (!LM) {
      setStatus('unsupported');
      return null;
    }
    setStatus('downloading');
    setDownloadProgress(0);

    // Seed each tab's session with the existing conversation so context
    // follows the user across tabs. Skip any in-flight streaming message.
    const history = messagesRef.current
      .filter((m) => !m.streaming && m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      const session = await LM.create({
        initialPrompts: [
          { role: 'system' as const, content: SYSTEM_PROMPT },
          ...history,
        ],
        monitor: (m) => {
          m.addEventListener('downloadprogress', (e: Event) => {
            const loaded = (e as ProgressEvent).loaded ?? 0;
            const pct = loaded > 1 ? loaded : loaded * 100;
            setDownloadProgress(Math.min(100, Math.round(pct)));
          });
        },
      });
      sessionRef.current = session;
      setStatus('available');
      return session;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('unavailable');
      return null;
    }
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (messagesRef.current.some((m) => m.streaming)) return; // another tab is busy

      const userMsg: ChatMessage = { id: newId(), role: 'user', content: trimmed };
      const assistantMsg: ChatMessage = {
        id: newId(),
        role: 'assistant',
        content: '',
        streaming: true,
      };

      // Local working copy. We mutate this as the stream progresses and
      // mirror it into storage so other tabs see the same updates.
      let local: ChatMessage[] = [...messagesRef.current, userMsg, assistantMsg];
      setMessages(local);
      setError(null);

      const startTs = Date.now();
      await writeStorage({
        [STORAGE_KEY_MESSAGES]: local,
        [STORAGE_KEY_LAST_ACTIVITY]: startTs,
      });
      scheduleIdleClear(startTs);

      const session = await ensureSession();
      if (!session) {
        local = local.map((m) =>
          m.id === assistantMsg.id
            ? { ...m, streaming: false, content: '⚠️ Augur AI is unavailable on this device.' }
            : m,
        );
        setMessages(local);
        await writeStorage({ [STORAGE_KEY_MESSAGES]: local });
        return;
      }

      const ac = new AbortController();
      abortRef.current = ac;

      let acc = '';
      let lastFlushTs = 0;

      const updateLocal = (content: string, streaming: boolean) => {
        local = local.map((m) =>
          m.id === assistantMsg.id ? { ...m, content, streaming } : m,
        );
        setMessages(local);
      };

      const flushToStorage = async (final: boolean): Promise<boolean> => {
        // If another tab cleared the conversation, our assistant message
        // is no longer in the canonical list — bail out without writing
        // so we don't resurrect cleared state.
        if (!messagesRef.current.some((m) => m.id === assistantMsg.id)) {
          ac.abort();
          return false;
        }
        const writes: Record<string, unknown> = { [STORAGE_KEY_MESSAGES]: local };
        if (final) writes[STORAGE_KEY_LAST_ACTIVITY] = Date.now();
        await writeStorage(writes);
        if (final) scheduleIdleClear(Date.now());
        return true;
      };

      try {
        const stream = session.promptStreaming(trimmed, { signal: ac.signal });
        const reader = stream.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (typeof value === 'string') {
            // Some Chrome builds emit cumulative text, others emit deltas.
            if (value.startsWith(acc) && value.length >= acc.length) {
              acc = value;
            } else {
              acc += value;
            }
            const now = Date.now();
            if (now - lastFlushTs > STREAM_FLUSH_MS) {
              lastFlushTs = now;
              updateLocal(acc, true);
              const ok = await flushToStorage(false);
              if (!ok) return;
            }
          }
        }
        updateLocal(acc, false);
        await flushToStorage(true);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') {
          updateLocal(acc, false);
          await flushToStorage(true);
          return;
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        setError(errMsg);
        updateLocal(`⚠️ ${errMsg}`, false);
        await flushToStorage(true);
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
      }
    },
    [ensureSession, scheduleIdleClear],
  );

  const stop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    } else {
      // No local stream — broadcast so the owning tab aborts.
      void writeStorage({ [STORAGE_KEY_STOP_SIGNAL]: Date.now() });
    }
  }, []);

  const clear = useCallback(async () => {
    abortRef.current?.abort();
    try {
      sessionRef.current?.destroy();
    } catch {
      // ignore
    }
    sessionRef.current = null;
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    setMessages([]);
    setError(null);
    await writeStorage({
      [STORAGE_KEY_MESSAGES]: [],
      [STORAGE_KEY_LAST_ACTIVITY]: null,
    });
  }, []);

  return {
    status,
    messages,
    downloadProgress,
    error,
    send,
    stop,
    clear,
    isStreaming: messages.some((m) => m.streaming),
  };
}
