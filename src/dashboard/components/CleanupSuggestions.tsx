import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  Box,
  Button,
  Card,
  Chip,
  IconButton,
  Skeleton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import CheckIcon from '@mui/icons-material/Check';
import SnoozeIcon from '@mui/icons-material/Snooze';
import RefreshIcon from '@mui/icons-material/Refresh';
import CleaningServicesIcon from '@mui/icons-material/CleaningServices';
import InventoryIcon from '@mui/icons-material/Inventory2';
import { extractDomain } from '../../shared/db';
import type { CleanupCandidate } from '../../shared/types';
import { callRpc } from '../../shared/rpc';
import {
  fetchCleanupRecommendations,
  reportCleanupFeedback,
  stashItems,
} from '../api/recommendations';
import { useDataSummary } from '../hooks/useDataSummary';
import { LearningEmptyState } from './LearningEmptyState';
import { notifyStashChanged } from './StashSection';
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

export function CleanupSuggestions() {
  const { t } = useTranslation();
  const [items, setItems] = useState<CleanupCandidate[] | null>(null);
  const [loading, setLoading] = useState(true);
  const { summary } = useDataSummary();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchCleanupRecommendations();
      setItems(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onAccept = async (c: CleanupCandidate) => {
    const domain = extractDomain(c.tab.url);
    await reportCleanupFeedback(domain, c.reason, c.features, 'accepted');
    if (c.tab.id !== undefined) {
      await callRpc({ kind: 'closeTabs', tabIds: [c.tab.id] });
    }
    setItems((prev) => (prev ? prev.filter((p) => p.tab.id !== c.tab.id) : prev));
  };

  const onDismiss = async (c: CleanupCandidate) => {
    const domain = extractDomain(c.tab.url);
    await reportCleanupFeedback(domain, c.reason, c.features, 'dismissed');
    setItems((prev) => (prev ? prev.filter((p) => p.tab.id !== c.tab.id) : prev));
  };

  const onSnooze = async (c: CleanupCandidate) => {
    const domain = extractDomain(c.tab.url);
    await reportCleanupFeedback(domain, c.reason, c.features, 'snoozed');
    setItems((prev) => (prev ? prev.filter((p) => p.tab.id !== c.tab.id) : prev));
  };

  const onStash = async (c: CleanupCandidate) => {
    const domain = extractDomain(c.tab.url);
    // Stashing counts as a soft positive: user agreed it shouldn't stay open.
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
    if (c.tab.id !== undefined) {
      await callRpc({ kind: 'closeTabs', tabIds: [c.tab.id] });
    }
    setItems((prev) => (prev ? prev.filter((p) => p.tab.id !== c.tab.id) : prev));
    toast({ message: t('toasts.tabsStashed', { count: 1 }), severity: 'success' });
  };

  const acceptAll = async () => {
    if (!items) return;
    const ids = items.map((c) => c.tab.id).filter((x): x is number => x !== undefined);
    for (const c of items) {
      const domain = extractDomain(c.tab.url);
      await reportCleanupFeedback(domain, c.reason, c.features, 'accepted');
    }
    if (ids.length > 0) {
      await callRpc({ kind: 'closeTabs', tabIds: ids });
      toast({
        message: t('toasts.tabsClosed', { count: ids.length }),
        severity: 'success',
      });
    }
    setItems([]);
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 2, gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="h5">{t('sections.cleanup')}</Typography>
        {items && items.length > 0 && (
          <Chip color="warning" size="small" label={items.length} />
        )}
        <Box sx={{ flex: 1 }} />
        {items && items.length > 0 && (
          <Button onClick={acceptAll} variant="contained" startIcon={<CheckIcon />} color="warning">
            {t('cleanup.acceptAll')}
          </Button>
        )}
        <Tooltip title={t('actions.refresh')}>
          <IconButton onClick={refresh} size="small">
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      {loading && items === null ? (
        <Stack spacing={1}>
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} variant="rounded" height={64} sx={{ borderRadius: 3 }} />
          ))}
        </Stack>
      ) : items && items.length > 0 ? (
        <Stack spacing={1}>
          {items.map((c) => (
            <Card
              key={c.tab.id}
              sx={{
                p: 1.5,
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                backgroundColor: 'rgba(179, 38, 30, 0.04)',
                borderColor: 'rgba(179, 38, 30, 0.2)',
              }}
            >
              <Avatar
                src={favicon(c.tab)}
                variant="rounded"
                sx={{ width: 32, height: 32, bgcolor: 'transparent' }}
              />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 500,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={c.tab.title ?? c.tab.url}
                >
                  {c.tab.title || c.tab.url}
                </Typography>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.25 }}>
                  <Typography variant="caption" color="text.secondary">
                    {extractDomain(c.tab.url)}
                  </Typography>
                  <Chip
                    size="small"
                    sx={{ height: 18, fontSize: 10 }}
                    label={t(`reasons.${c.reason}`, { defaultValue: c.reason })}
                  />
                  <Typography variant="caption" color="text.secondary">
                    {t('cleanup.idleFor', {
                      duration: fmtDuration(c.features.timeSinceFocusMs, t),
                    })}
                  </Typography>
                </Stack>
              </Box>
              <Tooltip title={t('cleanup.stash')}>
                <IconButton size="small" onClick={() => onStash(c)}>
                  <InventoryIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title={t('cleanup.snooze')}>
                <IconButton size="small" onClick={() => onSnooze(c)}>
                  <SnoozeIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title={t('cleanup.dismiss')}>
                <IconButton size="small" onClick={() => onDismiss(c)}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Button
                size="small"
                variant="contained"
                color="warning"
                startIcon={<CheckIcon />}
                onClick={() => onAccept(c)}
              >
                {t('cleanup.close')}
              </Button>
            </Card>
          ))}
        </Stack>
      ) : (
        <LearningEmptyState
          summary={summary}
          ready={summary?.cleanupReady ?? false}
          readyMessage={t('cleanup.empty')}
          warmupMessage={t('cleanup.warmup')}
          icon={<CleaningServicesIcon />}
        />
      )}
    </Box>
  );
}
