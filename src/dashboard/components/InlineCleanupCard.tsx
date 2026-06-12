import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  Box,
  Button,
  Card,
  Chip,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import CheckIcon from '@mui/icons-material/Check';
import InventoryIcon from '@mui/icons-material/Inventory2';
import CleaningServicesIcon from '@mui/icons-material/CleaningServices';
import { extractDomain } from '../../shared/db';
import type { CleanupCandidate } from '../../shared/types';
import { callRpc } from '../../shared/rpc';
import {
  fetchCleanupRecommendations,
  reportCleanupFeedback,
  stashItems,
} from '../api/recommendations';
import { notifyStashChanged } from './StashSection';
import { isCleanupSuppressed, suppressCleanup } from '../cleanupSuppression';
import { toast } from './Toaster';

function fmtDuration(ms: number, t: (k: string, opts?: Record<string, unknown>) => string): string {
  if (ms < 60_000) return t('duration.seconds', { count: Math.round(ms / 1000) });
  if (ms < 60 * 60_000) return t('duration.minutes', { count: Math.round(ms / 60_000) });
  if (ms < 24 * 60 * 60_000) return t('duration.hours', { count: Math.round(ms / 3_600_000) });
  return t('duration.days', { count: Math.round(ms / 86_400_000) });
}

function favicon(tab: chrome.tabs.Tab): string | undefined {
  if (tab.favIconUrl) return tab.favIconUrl;
  try {
    return tab.url
      ? `https://www.google.com/s2/favicons?sz=64&domain=${new URL(tab.url).hostname}`
      : undefined;
  } catch {
    return undefined;
  }
}

// Lives at the top of TabWall. Visually distinct (amber accent, ⚠️ chip)
// but uses the same row density as the rest of the tab list — cleanup is a
// high-frequency action, so it should feel like part of the tab list, not a
// detour to a separate page.
export function InlineCleanupCard() {
  const { t } = useTranslation();
  const [items, setItems] = useState<CleanupCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const data = await fetchCleanupRecommendations();
    // Drop any tab the user already chose to keep this session — the model
    // hasn't changed its mind yet, but the user's explicit "keep" wins.
    setItems(data.filter((c) => !isCleanupSuppressed(c.tab.id, c.tab.url)));
  }, []);

  useEffect(() => {
    void refresh();
    if (!chrome?.tabs?.onActivated) return;
    let pending = false;
    const trigger = () => {
      if (pending) return;
      pending = true;
      window.setTimeout(() => {
        pending = false;
        void refresh();
      }, 800);
    };
    chrome.tabs.onActivated.addListener(trigger);
    chrome.tabs.onRemoved.addListener(trigger);
    chrome.tabs.onUpdated.addListener(trigger);
    return () => {
      chrome.tabs.onActivated.removeListener(trigger);
      chrome.tabs.onRemoved.removeListener(trigger);
      chrome.tabs.onUpdated.removeListener(trigger);
    };
  }, [refresh]);

  if (!items || items.length === 0) return null;

  const removeLocal = (tabId: number | undefined) => {
    setItems((prev) => (prev ? prev.filter((p) => p.tab.id !== tabId) : prev));
  };

  const onAccept = async (c: CleanupCandidate) => {
    const domain = extractDomain(c.tab.url);
    await reportCleanupFeedback(domain, c.reason, c.features, 'accepted');
    if (c.tab.id !== undefined) await callRpc({ kind: 'closeTabs', tabIds: [c.tab.id] });
    removeLocal(c.tab.id);
    toast({ message: t('toasts.tabsClosed', { count: 1 }), severity: 'success' });
  };

  const onDismiss = async (c: CleanupCandidate) => {
    const domain = extractDomain(c.tab.url);
    // "Keep" = explicit, immediate intent. Suppress this tab from BOTH
    // cleanup surfaces for the session (broadcasts so TabWall drops it
    // from its coral-glow batch too) so it can't be closed by a later
    // "关闭所选", and won't reappear in this card on the next refresh.
    suppressCleanup(c.tab.id, c.tab.url);
    removeLocal(c.tab.id);
    await reportCleanupFeedback(domain, c.reason, c.features, 'dismissed');
  };

  const onStash = async (c: CleanupCandidate) => {
    const domain = extractDomain(c.tab.url);
    await reportCleanupFeedback(domain, c.reason, c.features, 'accepted');
    if (c.tab.url) {
      await stashItems([
        {
          url: c.tab.url,
          title: c.tab.title ?? c.tab.url,
          favIconUrl: c.tab.favIconUrl,
          source: 'cleanup',
        },
      ]);
      notifyStashChanged();
    }
    if (c.tab.id !== undefined) await callRpc({ kind: 'closeTabs', tabIds: [c.tab.id] });
    removeLocal(c.tab.id);
    toast({ message: t('toasts.tabsStashed', { count: 1 }), severity: 'success' });
  };

  const acceptAll = async () => {
    if (!items || busy) return;
    setBusy(true);
    try {
      const ids = items.map((c) => c.tab.id).filter((x): x is number => x !== undefined);
      for (const c of items) {
        const domain = extractDomain(c.tab.url);
        await reportCleanupFeedback(domain, c.reason, c.features, 'accepted');
      }
      if (ids.length > 0) {
        await callRpc({ kind: 'closeTabs', tabIds: ids });
        toast({ message: t('toasts.tabsClosed', { count: ids.length }), severity: 'success' });
      }
      setItems([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      sx={{
        mb: 1.5,
        p: 1.25,
        position: 'relative',
        overflow: 'hidden',
        // Amber accent so cleanup rows are visually distinct from the
        // neutral domain cards below, without being alarming.
        backgroundColor: 'rgba(217, 119, 6, 0.06)',
        borderColor: 'rgba(217, 119, 6, 0.30)',
      }}
    >
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          backgroundColor: 'rgba(217, 119, 6, 0.7)',
        }}
      />
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          mb: 0.75,
          pl: 0.5,
        }}
      >
        <CleaningServicesIcon sx={{ fontSize: 16, color: 'rgba(217, 119, 6, 0.9)' }} />
        <Typography sx={{ fontSize: 13, fontWeight: 500 }}>
          {t('sections.cleanup')}
        </Typography>
        <Chip
          size="small"
          label={items.length}
          sx={{
            height: 18,
            fontSize: 10,
            backgroundColor: 'rgba(217, 119, 6, 0.15)',
            color: 'rgba(217, 119, 6, 1)',
          }}
        />
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          onClick={acceptAll}
          variant="text"
          color="warning"
          startIcon={<CheckIcon sx={{ fontSize: 14 }} />}
          disabled={busy}
          sx={{ fontSize: 12, py: 0.25 }}
        >
          {t('cleanup.acceptAll')}
        </Button>
      </Box>
      <Stack spacing={0}>
        {items.map((c) => {
          const domain = extractDomain(c.tab.url);
          return (
            <Box
              key={c.tab.id}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.85,
                px: 0.75,
                py: 0.5,
                borderRadius: 1.5,
                '&:hover': {
                  backgroundColor: 'rgba(217, 119, 6, 0.08)',
                },
              }}
            >
              <Avatar
                src={favicon(c.tab)}
                variant="rounded"
                sx={{ width: 16, height: 16, bgcolor: 'transparent' }}
              />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography
                  sx={{
                    fontSize: 13,
                    fontWeight: 500,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    lineHeight: 1.2,
                  }}
                  title={c.tab.title ?? c.tab.url}
                >
                  {c.tab.title || c.tab.url}
                </Typography>
                <Typography
                  sx={{
                    fontSize: 10,
                    color: 'text.secondary',
                    lineHeight: 1.2,
                    mt: 0.1,
                  }}
                >
                  {domain} · {fmtDuration(c.features.timeSinceFocusMs, t)} ·{' '}
                  {t(`reasons.${c.reason}`, { defaultValue: c.reason })}
                </Typography>
              </Box>
              <Tooltip title={t('cleanup.dismiss')}>
                <IconButton size="small" onClick={() => onDismiss(c)} sx={{ p: 0.25 }}>
                  <CloseIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title={t('cleanup.stash')}>
                <IconButton size="small" onClick={() => onStash(c)} sx={{ p: 0.25 }}>
                  <InventoryIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title={t('cleanup.close')}>
                <IconButton
                  size="small"
                  onClick={() => onAccept(c)}
                  sx={{
                    p: 0.25,
                    color: 'rgba(217, 119, 6, 0.9)',
                  }}
                >
                  <CheckIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
            </Box>
          );
        })}
      </Stack>
    </Card>
  );
}
