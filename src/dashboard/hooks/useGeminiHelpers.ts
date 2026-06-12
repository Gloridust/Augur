import { useCallback, useEffect, useState } from 'react';

// Optional Chrome built-in Gemini Nano helpers for content generation —
// workspace naming, cleanup-reason copy, OracleHint subtitles. Strictly
// non-blocking: if the API isn't available (non-Chrome browsers, mainland
// China where the model can't be downloaded, or the user opted out in
// settings), these hooks return null and callers fall back to deterministic
// strings.
//
// CRITICAL: Gemini is NEVER used for ranking or candidate scoring — that
// path stays 100% deterministic (LR + RF + bandit + sequence memory). LLM
// participation is opt-in and only powers content text where heuristic
// alternatives exist as a fallback.

const PREF_KEY = 'augur:useGeminiHelpers';
const PREF_EVENT = 'augur:gemini-helpers-changed';

// `window.LanguageModel` is already typed in useGeminiChat.ts. We use a
// duck-typed accessor here so we don't redeclare the global (which would
// trigger TS "Subsequent property declarations must have the same type").
interface LMSessionLike {
  prompt(input: string, opts?: { signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}
interface LMLike {
  availability(): Promise<'unavailable' | 'downloadable' | 'downloading' | 'available'>;
  create(opts?: {
    initialPrompts?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    temperature?: number;
    topK?: number;
  }): Promise<LMSessionLike>;
}
function getLM(): LMLike | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { LanguageModel?: LMLike }).LanguageModel;
}

export type AiStatus = 'checking' | 'unavailable' | 'downloadable' | 'downloading' | 'available';

// ── Single source of truth for on-device AI capability ──────────────
// Probes `window.LanguageModel` once and reports a coarse status. Used by
// BOTH the settings UI (to show the availability banner + disable toggles)
// and the nav (to decide whether to mount the AI assistant button at all).
// Capability detection — not user-agent sniffing — so it works correctly on
// Edge / Brave / Arc (which may or may not ship the Prompt API) and degrades
// cleanly for Firefox / Safari / mainland-China Chrome where the model can't
// download. Everything outside the AI features works regardless.
export function useAiCapability(): { status: AiStatus; available: boolean } {
  const [status, setStatus] = useState<AiStatus>('checking');
  useEffect(() => {
    let cancelled = false;
    const lm = getLM();
    if (!lm) {
      setStatus('unavailable');
      return;
    }
    void lm
      .availability()
      .then((a) => {
        if (!cancelled) setStatus(a);
      })
      .catch(() => {
        if (!cancelled) setStatus('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const available =
    status === 'available' || status === 'downloadable' || status === 'downloading';
  return { status, available };
}

// ── AI assistant (nav chat) on/off preference ───────────────────────
const ASSISTANT_KEY = 'augur:aiAssistantEnabled';
const ASSISTANT_EVENT = 'augur:ai-assistant-changed';

function readAssistantPref(): boolean {
  // Default ON: capable users get the assistant out of the box. The nav
  // only mounts it when capability ALSO holds, so this defaulting can't
  // surface a dead button for non-Gemini browsers.
  try {
    const raw = localStorage.getItem(ASSISTANT_KEY);
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

export function isAiAssistantEnabled(): boolean {
  return readAssistantPref();
}

export function useAiAssistantPref(): [boolean, (v: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(readAssistantPref);
  useEffect(() => {
    const handler = (e: Event) => setEnabled(!!(e as CustomEvent<boolean>).detail);
    window.addEventListener(ASSISTANT_EVENT, handler);
    return () => window.removeEventListener(ASSISTANT_EVENT, handler);
  }, []);
  const set = useCallback((v: boolean) => {
    try {
      localStorage.setItem(ASSISTANT_KEY, v ? 'true' : 'false');
    } catch {
      // ignore
    }
    window.dispatchEvent(new CustomEvent<boolean>(ASSISTANT_EVENT, { detail: v }));
  }, []);
  return [enabled, set];
}

function readPref(): boolean {
  // Default OFF — explicit opt-in, never assumed. The settings toggle
  // surfaces the choice on first install.
  try {
    return localStorage.getItem(PREF_KEY) === 'true';
  } catch {
    return false;
  }
}

function writePref(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? 'true' : 'false');
  } catch {
    // ignore
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<boolean>(PREF_EVENT, { detail: on }));
  }
}

// Hook for Settings to bind to the toggle. Detects API availability so the
// UI can disable the toggle on browsers that don't support Gemini Nano
// (returns `apiAvailable: false`).
export function useGeminiHelpersPref(): {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  apiAvailable: boolean;
  status: 'checking' | 'unavailable' | 'downloadable' | 'downloading' | 'available';
} {
  const [enabled, setEnabled] = useState<boolean>(readPref);
  const [status, setStatus] =
    useState<'checking' | 'unavailable' | 'downloadable' | 'downloading' | 'available'>('checking');

  // Probe availability once (non-blocking; reads `window.LanguageModel`).
  useEffect(() => {
    let cancelled = false;
    const lm = getLM();
    if (!lm) {
      setStatus('unavailable');
      return;
    }
    void lm
      .availability()
      .then((a) => {
        if (!cancelled) setStatus(a);
      })
      .catch(() => {
        if (!cancelled) setStatus('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Cross-component sync via custom event (matches useUserName / useNewTabMode pattern).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail;
      setEnabled(!!detail);
    };
    window.addEventListener(PREF_EVENT, handler);
    return () => window.removeEventListener(PREF_EVENT, handler);
  }, []);

  const set = useCallback((v: boolean) => writePref(v), []);
  const apiAvailable = status === 'available' || status === 'downloadable' || status === 'downloading';
  return { enabled, setEnabled: set, apiAvailable, status };
}

// Direct check for use inside async generator functions. Returns true only
// if BOTH the user has opted in AND the API is reachable. Callers that
// want a generated string MUST always have a deterministic fallback ready.
export async function isGeminiHelpersReady(): Promise<boolean> {
  if (!readPref()) return false;
  const lm = getLM();
  if (!lm) return false;
  try {
    const a = await lm.availability();
    return a === 'available' || a === 'downloadable';
  } catch {
    return false;
  }
}

const GENERATION_TIMEOUT_MS = 8_000;

async function runOnce(systemPrompt: string, userPrompt: string): Promise<string | null> {
  if (!(await isGeminiHelpersReady())) return null;
  const LM = getLM();
  if (!LM) return null;
  let session: LMSessionLike | null = null;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);
  try {
    session = await LM.create({
      initialPrompts: [{ role: 'system', content: systemPrompt }],
      temperature: 0.7,
      topK: 40,
    });
    const out = await session.prompt(userPrompt, { signal: controller.signal });
    return typeof out === 'string' ? out.trim() : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
    try {
      session?.destroy();
    } catch {
      // ignore
    }
  }
}

// Suggest a short, human-readable name for a workspace given its tab
// domains. Returns null if Gemini is unavailable / disabled / errors —
// callers fall back to a deterministic name.
export async function suggestWorkspaceName(
  domains: string[],
): Promise<string | null> {
  if (domains.length === 0) return null;
  const top = domains.slice(0, 8).join(', ');
  const sys =
    'You name browser-tab workspaces. Reply with ONLY the name — 2 to 4 words, ' +
    'Title Case, no quotes, no punctuation. Match the language the user is likely working in.';
  const user = `Suggest a workspace name for these websites: ${top}`;
  const raw = await runOnce(sys, user);
  if (!raw) return null;
  // Sanitize: first line, strip quotes/asterisks, cap length.
  const cleaned = raw
    .split('\n')[0]
    .replace(/^["'`*\s]+|["'`*\s]+$/g, '')
    .slice(0, 40)
    .trim();
  return cleaned.length >= 2 ? cleaned : null;
}
