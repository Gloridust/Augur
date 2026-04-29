import { useEffect, useRef, useState } from 'react';
import { Avatar, Box } from '@mui/material';
import KeyboardReturnIcon from '@mui/icons-material/KeyboardReturn';
import type { OpenCandidate } from '../../shared/types';
import {
  fetchOpenRecommendations,
  logUiEvent,
  reportOpenFeedback,
} from '../api/recommendations';

// "Augur predicts" — Dynamic-Island-style capsule. Shows at the top of the
// new-tab page only when the recommendation model is genuinely confident
// (top candidate's calibrated probability ≥ 0.55). The user can ←/→ between
// the three best guesses, Enter opens the selected one in this tab, Esc
// dismisses, and the capsule self-destructs after a short idle window.
//
// Slot layout per product spec:
//   ┌──────────────────────────────────────────┐
//   │   [#2 left]   [★ #1 centre ★]   [#3 right] │
//   └──────────────────────────────────────────┘
// Default selection is the centre (most-likely) slot.

// Calibrated probability the top candidate must hit before the capsule
// shows. 0.55 was too strict given the recommend head's empirical class
// rate (~17% positive weighted), which after Platt calibration puts
// strong-but-not-certain candidates in the 0.45–0.65 range. 0.45 hits
// "model genuinely thinks this is more likely than not" without firing
// for noise. The smart-cleanup auto-select stays at 0.60 — closing tabs
// is more destructive than opening them, so it warrants stricter gating.
const CONFIDENCE_THRESHOLD = 0.45;
const AUTO_DISMISS_MS = 3_000;

function favicon(url: string): string {
  try {
    return `https://www.google.com/s2/favicons?sz=64&domain=${new URL(url).hostname}`;
  } catch {
    return '';
  }
}

// Visual position → candidates[] index. Centre is the top recommendation.
const SLOT_TO_CANDIDATE_INDEX = [1, 0, 2] as const;

export function OracleHint() {
  const [candidates, setCandidates] = useState<OpenCandidate[] | null>(null);
  const [selectedSlot, setSelectedSlot] = useState(1);
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const capsuleRef = useRef<HTMLDivElement | null>(null);

  // Fetch once on mount — each new tab is a fresh dashboard, so this fires
  // exactly when we want it (right after the user opens the page).
  useEffect(() => {
    let cancelled = false;
    void fetchOpenRecommendations().then((items) => {
      if (cancelled) return;
      if (items.length >= 3 && items[0].score >= CONFIDENCE_THRESHOLD) {
        setCandidates(items.slice(0, 3));
        setSelectedSlot(1);
        setVisible(true);
        logUiEvent({
          type: 'oracle_shown',
          domains: items.slice(0, 3).map((c) => c.domain),
          meta: {
            scores: items.slice(0, 3).map((c) => c.score),
            reasons: items.slice(0, 3).map((c) => c.reason),
          },
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = () => {
    setClosing(true);
    logUiEvent({ type: 'oracle_dismissed' });
    window.setTimeout(() => setVisible(false), 220);
  };

  const open = (c: OpenCandidate) => {
    void reportOpenFeedback(c.domain, c.features, 'accepted');
    logUiEvent({
      type: 'oracle_accepted',
      domain: c.domain,
      url: c.url,
      slotIndex: selectedSlot,
      meta: { reason: c.reason, score: c.score },
    });
    window.location.href = c.url;
  };

  // Keyboard binding: ←/→ to navigate, Enter to commit, Esc to dismiss.
  // Inputs (search bar etc.) are excluded so typing isn't hijacked.
  //
  // Focus dance: on a freshly-opened tab, Chrome parks keyboard focus in the
  // omnibox, so a window-level keydown listener never fires. We pull focus to
  // the capsule itself the moment it mounts (and re-pull on the next two
  // animation frames to defeat Chrome's deferred omnibox focus). Listening on
  // the capsule's own element instead of window also means we keep working
  // even if the user later tabs into a sibling element on the page.
  useEffect(() => {
    if (!visible || closing || !candidates) return;

    const node = capsuleRef.current;
    if (!node) return;

    // Pull focus aggressively — once synchronously, then twice via rAF, since
    // Chrome can re-focus the omnibox after the page first paints.
    node.focus({ preventScroll: true });
    const r1 = requestAnimationFrame(() => {
      node.focus({ preventScroll: true });
      const r2 = requestAnimationFrame(() => node.focus({ preventScroll: true }));
      (node as any).__r2 = r2;
    });

    const timer = window.setTimeout(dismiss, AUTO_DISMISS_MS);

    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt) {
        const tag = tgt.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tgt.isContentEditable) return;
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        window.clearTimeout(timer);
        setSelectedSlot((s) => Math.max(0, s - 1));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        window.clearTimeout(timer);
        setSelectedSlot((s) => Math.min(2, s + 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const c = candidates[SLOT_TO_CANDIDATE_INDEX[selectedSlot]];
        if (c) open(c);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        dismiss();
      }
    };

    // Listen on both window (in case page focus is already on the dashboard)
    // and the capsule itself (covers the case where focus moved to it). The
    // duplicate-event guard isn't needed because each event only bubbles
    // through one path — a capsule-targeted event reaches both, but onKey is
    // idempotent for the keys we care about (preventDefault + state setter).
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
      cancelAnimationFrame(r1);
      const r2 = (node as any).__r2;
      if (typeof r2 === 'number') cancelAnimationFrame(r2);
    };
  }, [visible, closing, candidates, selectedSlot]);

  if (!visible || !candidates) return null;

  const slotCandidates = SLOT_TO_CANDIDATE_INDEX.map((idx) => candidates[idx]);

  return (
    <Box
      ref={capsuleRef}
      role="dialog"
      aria-label="Augur prediction"
      tabIndex={-1}
      sx={{
        position: 'fixed',
        top: 14,
        left: '50%',
        outline: 'none',
        zIndex: (theme) => theme.zIndex.snackbar + 1,
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        py: 0.75,
        px: 1.25,
        borderRadius: 999,
        backgroundColor: 'rgba(31, 30, 27, 0.94)',
        backdropFilter: 'saturate(180%) blur(20px)',
        WebkitBackdropFilter: 'saturate(180%) blur(20px)',
        boxShadow: '0 8px 28px rgba(0, 0, 0, 0.22), inset 0 1px 0 rgba(255,255,255,0.08)',
        color: '#FCFAF5',
        transformOrigin: '50% 0',
        animation: closing
          ? 'augur-island-out 200ms cubic-bezier(0.4, 0, 1, 1) forwards'
          : 'augur-island-in 440ms cubic-bezier(0.34, 1.56, 0.64, 1)',
        '@keyframes augur-island-in': {
          '0%': {
            opacity: 0,
            transform: 'translate(-50%, -18px) scale(0.78)',
          },
          '60%': {
            opacity: 1,
          },
          '100%': {
            opacity: 1,
            transform: 'translate(-50%, 0) scale(1)',
          },
        },
        '@keyframes augur-island-out': {
          '0%': { opacity: 1, transform: 'translate(-50%, 0) scale(1)' },
          '100%': { opacity: 0, transform: 'translate(-50%, -10px) scale(0.92)' },
        },
        // Default centred state.
        transform: 'translate(-50%, 0) scale(1)',
      }}
    >
      {slotCandidates.map((c, slot) => {
        const isSelected = slot === selectedSlot;
        return (
          <Box
            key={c.url}
            role="button"
            tabIndex={-1}
            onClick={() => {
              if (isSelected) open(c);
              else setSelectedSlot(slot);
            }}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.85,
              py: 0.5,
              pl: 0.85,
              pr: isSelected ? 1 : 0.85,
              borderRadius: 999,
              cursor: 'pointer',
              transition:
                'background-color 280ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 280ms ease, transform 280ms cubic-bezier(0.34, 1.56, 0.64, 1), max-width 280ms cubic-bezier(0.34, 1.56, 0.64, 1)',
              opacity: isSelected ? 1 : 0.55,
              transform: isSelected ? 'scale(1.06)' : 'scale(1)',
              backgroundColor: isSelected
                ? 'rgba(217, 119, 87, 0.30)'
                : 'transparent',
              maxWidth: isSelected ? 260 : 140,
              minWidth: 0,
              '&:hover': isSelected
                ? undefined
                : { opacity: 0.78, backgroundColor: 'rgba(255,255,255,0.06)' },
            }}
          >
            <Avatar
              src={favicon(c.url)}
              variant="rounded"
              sx={{
                width: 18,
                height: 18,
                bgcolor: 'transparent',
                flexShrink: 0,
              }}
            />
            <Box
              sx={{
                fontSize: 12.5,
                fontWeight: isSelected ? 500 : 400,
                lineHeight: 1.1,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                minWidth: 0,
              }}
            >
              {c.title || c.domain}
            </Box>
            {isSelected && (
              <Box
                aria-hidden
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 18,
                  height: 18,
                  borderRadius: 999,
                  backgroundColor: 'rgba(255,255,255,0.14)',
                  flexShrink: 0,
                }}
              >
                <KeyboardReturnIcon sx={{ fontSize: 12, opacity: 0.85 }} />
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
