import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import InventoryIcon from '@mui/icons-material/Inventory2';
import CleaningServicesIcon from '@mui/icons-material/CleaningServices';
import type { CleanupCandidate, CleanupTier } from '../../shared/types';
import { extractDomain } from '../../shared/db';
import { callRpc } from '../../shared/rpc';
import {
  fetchCleanupSweep,
  logUiEvent,
  reportCleanupFeedback,
  stashItems,
} from '../api/recommendations';
import { isCleanupSuppressed, suppressCleanup } from '../cleanupSuppression';
import { notifyStashChanged } from './StashSection';
import { toast } from './Toaster';

// Tier presentation, ordered most→least obviously a zombie. `defaultOn`
// controls whether the tier's rows are pre-checked: the confident tiers
// (never-opened / week / day) are checked so a single "Close" nukes the safe
// bulk; the recent tiers (a few hours / model-only) start unchecked so the
// user opts in. Colors stay in the amber family to match the cleanup accent.
const TIER_META: Record<
  CleanupTier,
  { defaultOn: boolean; order: number }
> = {
  never_opened: { defaultOn: true, order: 0 },
  stale_week: { defaultOn: true, order: 1 },
  stale_day: { defaultOn: true, order: 2 },
  stale: { defaultOn: false, order: 3 },
  model: { defaultOn: false, order: 4 },
};

function tierLabel(tier: CleanupTier, t: (k: string, o?: Record<string, unknown>) => string): string {
  return t(`declutter.tier.${tier}`, {
    defaultValue: {
      never_opened: 'Never viewed',
      stale_week: 'Idle 1+ week',
      stale_day: 'Idle 1+ day',
      stale: 'Idle a few hours',
      model: 'Model-flagged',
    }[tier],
  });
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

function fmtAgo(ms: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (ms < 60_000) return t('duration.seconds', { count: Math.round(ms / 1000) });
  if (ms < 60 * 60_000) return t('duration.minutes', { count: Math.round(ms / 60_000) });
  if (ms < 24 * 60 * 60_000) return t('duration.hours', { count: Math.round(ms / 3_600_000) });
  return t('duration.days', { count: Math.round(ms / 86_400_000) });
}

// Caption for a row: for never-viewed tabs, age-since-open is the meaningful
// number; for everything else, time-since-last-focus.
function rowCaption(
  c: CleanupCandidate,
  t: (k: string, o?: Record<string, unknown>) => string,
): string {
  const domain = extractDomain(c.tab.url);
  if (c.tier === 'never_opened') {
    return `${domain} · ${t('declutter.openedAgo', {
      defaultValue: 'opened {{ago}} ago, never viewed',
      ago: fmtAgo(c.features.tabAgeMs, t),
    })}`;
  }
  return `${domain} · ${t('declutter.idleFor', {
    defaultValue: 'idle {{ago}}',
    ago: fmtAgo(c.features.timeSinceFocusMs, t),
  })}`;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function DeclutterDialog({ open, onClose }: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [candidates, setCandidates] = useState<CleanupCandidate[]>([]);
  const [totalTabs, setTotalTabs] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sweep = await fetchCleanupSweep();
      const live = sweep.candidates.filter(
        (c) => c.tab.id !== undefined && !isCleanupSuppressed(c.tab.id, c.tab.url),
      );
      setCandidates(live);
      setTotalTabs(sweep.totalTabs);
      // Pre-select the confident tiers.
      const pre = new Set<number>();
      for (const c of live) {
        if (c.tab.id !== undefined && c.tier && TIER_META[c.tier].defaultOn) {
          pre.add(c.tab.id);
        }
      }
      setSelected(pre);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Group candidates by tier, in tier order.
  const groups = useMemo(() => {
    const byTier = new Map<CleanupTier, CleanupCandidate[]>();
    for (const c of candidates) {
      const tier = c.tier ?? 'model';
      const arr = byTier.get(tier) ?? [];
      arr.push(c);
      byTier.set(tier, arr);
    }
    return Array.from(byTier.entries()).sort(
      (a, b) => TIER_META[a[0]].order - TIER_META[b[0]].order,
    );
  }, [candidates]);

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleGroup = (rows: CleanupCandidate[]) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const ids = rows.map((c) => c.tab.id).filter((x): x is number => x !== undefined);
      const allOn = ids.every((id) => next.has(id));
      for (const id of ids) (allOn ? next.delete(id) : next.add(id));
      return next;
    });

  const allIds = useMemo(
    () => candidates.map((c) => c.tab.id).filter((x): x is number => x !== undefined),
    [candidates],
  );
  const allOn = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const toggleAll = () =>
    setSelected(allOn ? new Set() : new Set(allIds));

  const selectedCandidates = () =>
    candidates.filter((c) => c.tab.id !== undefined && selected.has(c.tab.id));

  // Shared commit path: report feedback for every closed tab, then either
  // close or stash. `stash` decides which terminal action runs.
  const commit = async (stash: boolean) => {
    if (busy) return;
    const picked = selectedCandidates();
    const ids = picked.map((c) => c.tab.id!).filter((x) => x !== undefined);
    if (ids.length === 0) return;
    setBusy(true);
    try {
      // Train: the user accepting a bulk-sweep pick is a positive cleanup
      // signal, exactly like the inline card's accept.
      await Promise.all(
        picked.map((c) => {
          const domain = extractDomain(c.tab.url);
          return domain
            ? reportCleanupFeedback(domain, c.reason, c.features, 'accepted').catch(() => undefined)
            : Promise.resolve();
        }),
      );
      logUiEvent({
        type: 'smart_cleanup_committed',
        count: ids.length,
        meta: {
          surface: 'declutter',
          stashed: stash,
          tiers: picked.map((c) => c.tier),
        },
      });
      if (stash) {
        const items = picked
          .filter((c) => c.tab.url)
          .map((c) => ({
            url: c.tab.url!,
            title: c.tab.title ?? c.tab.url!,
            favIconUrl: c.tab.favIconUrl,
            source: 'cleanup' as const,
          }));
        if (items.length > 0) {
          await stashItems(items);
          notifyStashChanged();
        }
      }
      await callRpc({ kind: 'closeTabs', tabIds: ids });
      toast({
        message: stash
          ? t('toasts.tabsStashed', { count: ids.length })
          : t('toasts.tabsClosed', { count: ids.length }),
        severity: 'success',
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  // "Keep" a single row — suppress it for the session and drop it from view.
  const keep = (c: CleanupCandidate) => {
    suppressCleanup(c.tab.id, c.tab.url);
    setCandidates((prev) => prev.filter((p) => p.tab.id !== c.tab.id));
    if (c.tab.id !== undefined) {
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(c.tab.id!);
        return next;
      });
    }
    const domain = extractDomain(c.tab.url);
    if (domain) void reportCleanupFeedback(domain, c.reason, c.features, 'dismissed');
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pb: 1 }}>
        <CleaningServicesIcon sx={{ fontSize: 20, color: 'rgba(217, 119, 6, 0.9)' }} />
        <Box sx={{ flex: 1 }}>
          <Typography sx={{ fontSize: 16, fontWeight: 600, lineHeight: 1.2 }}>
            {t('declutter.title', { defaultValue: 'Declutter tabs' })}
          </Typography>
          {!loading && (
            <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.25 }}>
              {t('declutter.subtitle', {
                defaultValue: '{{stale}} of {{total}} open tabs are stale',
                stale: candidates.length,
                total: totalTabs,
              })}
            </Typography>
          )}
        </Box>
        <IconButton size="small" onClick={onClose} disabled={busy}>
          <CloseIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers sx={{ p: 0, maxHeight: '60vh' }}>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress size={28} />
          </Box>
        ) : candidates.length === 0 ? (
          <Box sx={{ py: 6, px: 3, textAlign: 'center' }}>
            <Typography color="text.secondary" variant="body2">
              {t('declutter.empty', { defaultValue: 'No stale tabs — your tab set is tidy.' })}
            </Typography>
          </Box>
        ) : (
          <Box>
            {/* Select-all bar */}
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 2,
                py: 1,
                position: 'sticky',
                top: 0,
                zIndex: 1,
                backgroundColor: 'background.paper',
              }}
            >
              <Checkbox
                size="small"
                checked={allOn}
                indeterminate={selected.size > 0 && !allOn}
                onChange={toggleAll}
                sx={{ p: 0.25 }}
              />
              <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                {t('declutter.selectAll', { defaultValue: 'Select all' })}
              </Typography>
            </Box>
            <Divider />
            {groups.map(([tier, rows], gi) => {
              const ids = rows.map((c) => c.tab.id).filter((x): x is number => x !== undefined);
              const groupOn = ids.length > 0 && ids.every((id) => selected.has(id));
              const groupSome = ids.some((id) => selected.has(id));
              return (
                <Box key={tier}>
                  {gi > 0 && <Divider />}
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1,
                      px: 2,
                      py: 0.75,
                      backgroundColor: 'rgba(217, 119, 6, 0.04)',
                    }}
                  >
                    <Checkbox
                      size="small"
                      checked={groupOn}
                      indeterminate={groupSome && !groupOn}
                      onChange={() => toggleGroup(rows)}
                      sx={{ p: 0.25 }}
                    />
                    <Typography sx={{ fontSize: 12, fontWeight: 600 }}>
                      {tierLabel(tier, t)}
                    </Typography>
                    <Chip
                      size="small"
                      label={rows.length}
                      sx={{
                        height: 17,
                        fontSize: 10,
                        backgroundColor: 'rgba(217, 119, 6, 0.12)',
                        color: 'rgba(180, 83, 9, 1)',
                      }}
                    />
                  </Box>
                  {rows.map((c) => (
                    <Box
                      key={c.tab.id}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1,
                        px: 2,
                        py: 0.6,
                        '&:hover': { backgroundColor: 'var(--mui-palette-action-hover)' },
                      }}
                    >
                      <Checkbox
                        size="small"
                        checked={c.tab.id !== undefined && selected.has(c.tab.id)}
                        onChange={() => c.tab.id !== undefined && toggle(c.tab.id)}
                        sx={{ p: 0.25 }}
                      />
                      <Avatar
                        src={favicon(c.tab)}
                        variant="rounded"
                        sx={{ width: 16, height: 16, bgcolor: 'transparent', flexShrink: 0 }}
                      />
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography
                          sx={{
                            fontSize: 13,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            lineHeight: 1.25,
                          }}
                          title={c.tab.title ?? c.tab.url}
                        >
                          {c.tab.title || c.tab.url}
                        </Typography>
                        <Typography
                          sx={{
                            fontSize: 10.5,
                            color: 'text.secondary',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            lineHeight: 1.25,
                          }}
                        >
                          {rowCaption(c, t)}
                        </Typography>
                      </Box>
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => keep(c)}
                        sx={{ fontSize: 11, py: 0.1, minWidth: 0, color: 'text.secondary' }}
                      >
                        {t('declutter.keep', { defaultValue: 'Keep' })}
                      </Button>
                    </Box>
                  ))}
                </Box>
              );
            })}
          </Box>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 2, py: 1.25, gap: 1 }}>
        <Button onClick={onClose} disabled={busy} sx={{ mr: 'auto' }}>
          {t('common.cancel', { defaultValue: 'Cancel' })}
        </Button>
        <Button
          onClick={() => void commit(true)}
          disabled={busy || selected.size === 0}
          variant="outlined"
          color="warning"
          startIcon={<InventoryIcon sx={{ fontSize: 16 }} />}
        >
          {t('declutter.stashN', { defaultValue: 'Stash {{n}}', n: selected.size })}
        </Button>
        <Button
          onClick={() => void commit(false)}
          disabled={busy || selected.size === 0}
          variant="contained"
          color="warning"
          startIcon={<CloseIcon sx={{ fontSize: 16 }} />}
        >
          {t('declutter.closeN', { defaultValue: 'Close {{n}}', n: selected.size })}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
