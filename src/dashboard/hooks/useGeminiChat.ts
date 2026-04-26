import { useCallback, useEffect, useRef, useState } from 'react';

// Wraps Chrome's built-in Prompt API (`window.LanguageModel`, Chrome 138+ for
// extensions). Talks to on-device Gemini Nano — no key, no network. The
// surface is intentionally minimal: messages list, send, clear, plus a 30-min
// idle timer that wipes the conversation and destroys the session.

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

// Ambient typing for the global. Kept inline since this is the only consumer.
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
  // While streaming, the assistant message has `streaming: true` until the
  // ReadableStream closes.
  streaming?: boolean;
}

export type ChatStatus =
  | 'unsupported'   // No LanguageModel global — Chrome <138 or non-Chrome.
  | 'unavailable'   // Hardware/OS can't run Gemini Nano.
  | 'downloadable'  // Idle, will download on first prompt.
  | 'downloading'   // Model download in progress.
  | 'available'     // Ready.
  | 'checking';     // Initial load.

const IDLE_CLEAR_MS = 30 * 60 * 1_000;

const SYSTEM_PROMPT = [
  'You are Augur, the on-device assistant inside the user\'s new tab page.',
  'Be concise and warm. Aim for short answers (≤3 short paragraphs) unless the user asks for detail.',
  'Reply in the same language the user wrote in.',
  'You run entirely on-device via Gemini Nano — no internet, no logs leave the browser. If the user asks for live information you cannot have, say so plainly.',
].join(' ');

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useGeminiChat() {
  const [status, setStatus] = useState<ChatStatus>('checking');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<LMSession | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const idleTimerRef = useRef<number | null>(null);

  // Probe availability once on mount.
  useEffect(() => {
    let cancelled = false;
    if (typeof window === 'undefined' || !window.LanguageModel) {
      setStatus('unsupported');
      return;
    }
    void window.LanguageModel.availability().then((a) => {
      if (cancelled) return;
      setStatus(a);
    }).catch(() => {
      if (!cancelled) setStatus('unsupported');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const destroySession = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    try {
      sessionRef.current?.destroy();
    } catch {
      // session may already be torn down
    }
    sessionRef.current = null;
  }, []);

  const clear = useCallback(() => {
    destroySession();
    setMessages([]);
    setError(null);
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, [destroySession]);

  // Reset the 30-min idle clear on each user/assistant turn.
  const bumpIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
    }
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      clear();
    }, IDLE_CLEAR_MS);
  }, [clear]);

  // Tear everything down on unmount.
  useEffect(() => {
    return () => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
      }
      destroySession();
    };
  }, [destroySession]);

  const ensureSession = useCallback(async (): Promise<LMSession | null> => {
    if (sessionRef.current) return sessionRef.current;
    const LM = window.LanguageModel;
    if (!LM) {
      setStatus('unsupported');
      return null;
    }
    setStatus('downloading');
    setDownloadProgress(0);
    try {
      const session = await LM.create({
        initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
        monitor: (m) => {
          m.addEventListener('downloadprogress', (e: Event) => {
            const loaded = (e as ProgressEvent).loaded ?? 0;
            // Some Chrome versions emit 0..1, others 0..100. Normalize.
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

      const userMsg: ChatMessage = { id: newId(), role: 'user', content: trimmed };
      const assistantMsg: ChatMessage = {
        id: newId(),
        role: 'assistant',
        content: '',
        streaming: true,
      };
      setMessages((m) => [...m, userMsg, assistantMsg]);
      setError(null);
      bumpIdleTimer();

      const session = await ensureSession();
      if (!session) {
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantMsg.id
              ? { ...msg, streaming: false, content: '⚠️ Augur AI is unavailable on this device.' }
              : msg,
          ),
        );
        return;
      }

      const ac = new AbortController();
      abortRef.current = ac;

      try {
        const stream = session.promptStreaming(trimmed, { signal: ac.signal });
        const reader = stream.getReader();
        let acc = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          // Some Chrome builds stream cumulative text, others stream deltas.
          // Detect by checking if the new chunk starts with the accumulated
          // value — if so, treat as cumulative; otherwise append.
          if (typeof value === 'string') {
            if (value.startsWith(acc) && value.length >= acc.length) {
              acc = value;
            } else {
              acc += value;
            }
            const snapshot = acc;
            setMessages((m) =>
              m.map((msg) =>
                msg.id === assistantMsg.id ? { ...msg, content: snapshot } : msg,
              ),
            );
          }
        }
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantMsg.id ? { ...msg, streaming: false } : msg,
          ),
        );
        bumpIdleTimer();
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') {
          setMessages((m) =>
            m.map((msg) =>
              msg.id === assistantMsg.id ? { ...msg, streaming: false } : msg,
            ),
          );
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setMessages((m) =>
          m.map((x) =>
            x.id === assistantMsg.id ? { ...x, streaming: false, content: `⚠️ ${msg}` } : x,
          ),
        );
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
      }
    },
    [bumpIdleTimer, ensureSession],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
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
