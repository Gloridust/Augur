import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  Box,
  Button,
  Card,
  Checkbox,
  Chip,
  IconButton,
  InputBase,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PushPinIcon from '@mui/icons-material/PushPin';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import InventoryIcon from '@mui/icons-material/Inventory2';
import LayersIcon from '@mui/icons-material/Layers';
import LanguageIcon from '@mui/icons-material/Language';
import WindowIcon from '@mui/icons-material/Window';
import SearchIcon from '@mui/icons-material/Search';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { activateTab, closeTabs, useTabs } from '../hooks/useTabs';
import {
  fetchAllCleanupCandidates,
  reportCleanupFeedback,
  stashItems,
} from '../api/recommendations';
import { extractDomain } from '../../shared/db';
import type { CleanupCandidate } from '../../shared/types';
import { usePins } from '../hooks/usePins';
import { notifyStashChanged } from './StashSection';
import { InlineCleanupCard } from './InlineCleanupCard';
import { toast } from './Toaster';

type GroupMode = 'domain' | 'window';

interface CardGroup {
  key: string;
  label: string;
  subLabel?: string;
  tabs: chrome.tabs.Tab[];
  accentHue?: number;
  showFavicon?: boolean;
}

function faviconUrl(tab: chrome.tabs.Tab): string | undefined {
  if (tab.favIconUrl) return tab.favIconUrl;
  if (!tab.url) return undefined;
  try {
    const u = new URL(tab.url);
    return `https://www.google.com/s2/favicons?sz=64&domain=${u.hostname}`;
  } catch {
    return undefined;
  }
}

// Deterministic accent hue per windowId — gives each window its own color stripe.
function hueForWindow(windowId: number, indexOffset: number): number {
  const seed = (windowId * 2654435761) >>> 0;
  return (seed % 360 + indexOffset * 60) % 360;
}

interface Props {
  filter?: string;
  dense?: boolean;
}

export function TabWall({ filter: externalFilter, dense = false }: Props) {
  const { t } = useTranslation();
  const { groups, windowGroups, tabs } = useTabs();
  const { isPinned, add: pinAdd, remove: pinRemove } = usePins();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Tabs the cleanup model recommended in the current "smart cleanup" batch.
  // Persists independently of `selected` so the coral glow stays visible
  // even after the user unchecks a row — the unchecked-but-glowing state is
  // exactly the signal we need to harvest as a correction.
  const [aiSelected, setAiSelected] = useState<Map<number, CleanupCandidate>>(new Map());
  const [smartLoading, setSmartLoading] = useState(false);
  // Cooldown after the user explicitly clears the AI batch — prevents the
  // visibility-change auto-rerun from immediately re-selecting the tabs
  // they just rejected.
  const lastDismissTsRef = useRef<number>(0);
  // Track whether we've done the on-mount auto-run yet so it fires exactly
  // once after `tabs` first populates (not on every re-render).
  const hasAutoRunRef = useRef(false);
  const [internalFilter, setInternalFilter] = useState('');
  const filter = externalFilter ?? internalFilter;
  const [mode, setMode] = useState<GroupMode>(() => {
    const saved = (typeof localStorage !== 'undefined'
      ? (localStorage.getItem('augur:tabWallMode') as GroupMode | null)
      : null);
    return saved === 'window' ? 'window' : 'domain';
  });
  const [focusedTabId, setFocusedTabId] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem('augur:tabWallMode', mode);
    } catch {
      // ignore
    }
  }, [mode]);

  const cardGroups: CardGroup[] = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matchTab = (tab: chrome.tabs.Tab, extra?: string): boolean => {
      if (!q) return true;
      return (
        (tab.title ?? '').toLowerCase().includes(q) ||
        (tab.url ?? '').toLowerCase().includes(q) ||
        (extra ?? '').toLowerCase().includes(q)
      );
    };

    if (mode === 'domain') {
      return groups
        .map((g): CardGroup => ({
          key: `domain:${g.domain}`,
          label: g.domain,
          tabs: g.tabs.filter((tb) => matchTab(tb, g.domain)),
          showFavicon: true,
        }))
        .filter((g) => g.tabs.length > 0);
    }
    return windowGroups
      .map((wg): CardGroup => ({
        key: `window:${wg.windowId}`,
        label: t('tabs.windowLabel', { index: wg.windowIndex + 1 }),
        subLabel: wg.activeTabTitle,
        tabs: wg.tabs.filter((tb) => matchTab(tb)),
        accentHue: hueForWindow(wg.windowId, wg.windowIndex),
      }))
      .filter((g) => g.tabs.length > 0);
  }, [groups, windowGroups, filter, mode, t]);

  // Flat ordered list of tabIds for keyboard navigation across cards.
  const flatTabIds = useMemo(() => {
    const ids: number[] = [];
    for (const g of cardGroups) {
      for (const tb of g.tabs) {
        if (tb.id !== undefined) ids.push(tb.id);
      }
    }
    return ids;
  }, [cardGroups]);

  useEffect(() => {
    if (focusedTabId === null) return;
    if (!flatTabIds.includes(focusedTabId)) {
      setFocusedTabId(flatTabIds[0] ?? null);
    }
  }, [flatTabIds, focusedTabId]);

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectGroup = (groupTabs: chrome.tabs.Tab[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const ids = groupTabs.map((t) => t.id).filter((x): x is number => x !== undefined);
      const allSelected = ids.every((id) => next.has(id));
      for (const id of ids) (allSelected ? next.delete(id) : next.add(id));
      return next;
    });
  };

  // For every tab the model suggested in the current smart-cleanup batch,
  // emit a feedback row:
  //   - still selected → 'accepted' (user agreed with the model)
  //   - unchecked     → 'dismissed-after-suggestion' (high-value
  //     correction; trained at 2x weight in trainCleanupFeedback because
  //     it directly contradicts a confident model prediction)
  const flushSmartCleanupFeedback = async (
    finalSelected: Set<number>,
  ): Promise<void> => {
    if (aiSelected.size === 0) return;
    const tasks: Promise<void>[] = [];
    for (const [tabId, candidate] of aiSelected) {
      const action = finalSelected.has(tabId)
        ? 'accepted'
        : 'dismissed-after-suggestion';
      const domain = extractDomain(candidate.tab.url);
      if (!domain) continue;
      tasks.push(
        reportCleanupFeedback(domain, candidate.reason, candidate.features, action).catch(
          () => undefined,
        ),
      );
    }
    await Promise.all(tasks);
  };

  const closeSelected = async () => {
    const ids = Array.from(selected);
    await flushSmartCleanupFeedback(selected);
    await closeTabs(ids);
    setSelected(new Set());
    setAiSelected(new Map());
    if (ids.length > 0) {
      toast({ message: t('toasts.tabsClosed', { count: ids.length }), severity: 'success' });
    }
  };

  // Manual "Clear" button: if the user dismisses an AI batch entirely
  // without closing anything, treat every AI-selected tab as 'dismissed' —
  // they explicitly walked away from the model's suggestion. Also stamps a
  // cooldown so the next visibility-change tick doesn't immediately
  // re-select the same tabs.
  const clearSelection = () => {
    void flushSmartCleanupFeedback(new Set());
    setSelected(new Set());
    setAiSelected(new Map());
    lastDismissTsRef.current = Date.now();
  };

  // `announce` controls whether we surface toasts. The button click sets it
  // true (user expects feedback); on-mount + visibility-change auto-runs
  // pass false so we don't spam notifications every time the dashboard
  // becomes visible.
  const runSmartCleanup = useCallback(
    async (announce: boolean = true) => {
      if (smartLoading) return;
      setSmartLoading(true);
      try {
        const candidates = await fetchAllCleanupCandidates();
        const openIds = new Set(
          tabs.map((tb) => tb.id).filter((x): x is number => x !== undefined),
        );
        // Uncertainty rejection: backend filters at >= 0.55 (the candidate
        // threshold), but auto-select demands stricter confidence — only
        // tabs at >= 0.60 calibrated probability go into the auto-checked
        // batch. The 0.55–0.60 band stays visible elsewhere (InlineCleanupCard)
        // but doesn't get prefilled here, where the cost of a false
        // positive is higher (user might miss-close an important tab).
        const AUTO_SELECT_THRESHOLD = 0.6;
        const map = new Map<number, CleanupCandidate>();
        const candidateIds = new Set<number>();
        for (const c of candidates) {
          if (c.score < AUTO_SELECT_THRESHOLD) continue;
          if (c.tab.id !== undefined && openIds.has(c.tab.id)) {
            map.set(c.tab.id, c);
            candidateIds.add(c.tab.id);
          }
        }
        if (map.size === 0) {
          if (announce) {
            toast({ message: t('cleanup.smartNoMatches'), severity: 'info' });
          }
          return;
        }
        setAiSelected(map);
        // Functional update so this works regardless of stale `selected`
        // captures (important for the auto-run path).
        setSelected((prev) => {
          const next = new Set(prev);
          for (const id of candidateIds) next.add(id);
          return next;
        });
        if (announce) {
          toast({
            message: t('cleanup.smartFound', { count: map.size }),
            severity: 'success',
          });
        }
      } finally {
        setSmartLoading(false);
      }
    },
    [smartLoading, tabs, t],
  );

  // Auto-run #1: on mount, once `tabs` has populated. Each new dashboard
  // tab gets a fresh model evaluation without the user pressing anything.
  useEffect(() => {
    if (hasAutoRunRef.current) return;
    if (tabs.length === 0) return;
    hasAutoRunRef.current = true;
    void runSmartCleanup(false);
  }, [tabs.length, runSmartCleanup]);

  // Auto-run #2: every time the dashboard becomes visible (user switches
  // back to this tab). Skipped when:
  //   - the user is mid-batch (selected or AI batch still active), or
  //   - the user dismissed a batch in the last 30s (cooldown).
  useEffect(() => {
    const COOLDOWN_MS = 30_000;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (selected.size > 0 || aiSelected.size > 0) return;
      if (Date.now() - lastDismissTsRef.current < COOLDOWN_MS) return;
      void runSmartCleanup(false);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [selected.size, aiSelected.size, runSmartCleanup]);

  const closeGroup = async (groupTabs: chrome.tabs.Tab[]) => {
    const ids = groupTabs.map((t) => t.id).filter((x): x is number => x !== undefined);
    await closeTabs(ids);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    if (ids.length > 0) {
      toast({ message: t('toasts.tabsClosed', { count: ids.length }), severity: 'success' });
    }
  };

  const stashTabsByIds = async (ids: number[]) => {
    const items = ids
      .map((id) => tabs.find((tb) => tb.id === id))
      .filter((tb): tb is chrome.tabs.Tab => !!tb && !!tb.url)
      .map((tb) => ({
        url: tb.url ?? '',
        title: tb.title ?? tb.url ?? '',
        favIconUrl: tb.favIconUrl,
        source: 'manual' as const,
      }));
    if (items.length === 0) return;
    await stashItems(items);
    notifyStashChanged();
    await closeTabs(ids);
    toast({ message: t('toasts.tabsStashed', { count: items.length }), severity: 'success' });
  };

  const stashSelected = async () => {
    await stashTabsByIds(Array.from(selected));
    setSelected(new Set());
  };

  const stashGroup = async (groupTabs: chrome.tabs.Tab[]) => {
    const ids = groupTabs.map((t) => t.id).filter((x): x is number => x !== undefined);
    await stashTabsByIds(ids);
  };

  const moveFocus = (delta: number) => {
    if (flatTabIds.length === 0) return;
    const cur = focusedTabId !== null ? flatTabIds.indexOf(focusedTabId) : -1;
    const nextIdx = cur < 0 ? 0 : Math.max(0, Math.min(flatTabIds.length - 1, cur + delta));
    setFocusedTabId(flatTabIds[nextIdx]);
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === ' ') {
      e.preventDefault();
      if (focusedTabId !== null) toggle(focusedTabId);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (focusedTabId !== null) {
        const tab = tabs.find((tb) => tb.id === focusedTabId);
        if (tab) void activateTab(tab);
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (focusedTabId !== null) {
        e.preventDefault();
        void closeTabs([focusedTabId]);
      }
    } else if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setSelected(new Set(flatTabIds));
    }
  };

  // Density tokens — single source of truth for the row/header sizing knobs.
  const sizes = dense
    ? {
        cardPadding: 1.25,
        headerFavicon: 22,
        rowFavicon: 14,
        rowPaddingY: 0.4,
        rowPaddingX: 0.75,
        rowGap: 0.85,
        headerGap: 1,
        // 1 col on lg laptops (the right pane is narrow there), 2 cols once
        // we have headroom — packs domain cards more efficiently on 1440+.
        innerGridCols: { xs: '1fr', xl: 'repeat(2, 1fr)' },
        cardSpacing: 1.5,
        rowFontSize: 13,
        domainFontSize: 13,
        captionFontSize: 11,
      }
    : {
        cardPadding: 2,
        headerFavicon: 32,
        rowFavicon: 16,
        rowPaddingY: 0.75,
        rowPaddingX: 1,
        rowGap: 1,
        headerGap: 1.5,
        innerGridCols: {
          xs: '1fr',
          sm: 'repeat(2, 1fr)',
          md: 'repeat(3, 1fr)',
          lg: 'repeat(4, 1fr)',
          xl: 'repeat(5, 1fr)',
        },
        cardSpacing: 2,
        rowFontSize: 14,
        domainFontSize: 14,
        captionFontSize: 12,
      };

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          mb: 1.5,
          gap: 1,
          flexWrap: 'wrap',
        }}
      >
        <Typography variant="h6" sx={{ fontWeight: 500 }}>
          {t('sections.openTabs')}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {t('tabs.count', { count: tabs.length })} ·{' '}
          {mode === 'domain'
            ? t('tabs.domainCount', { count: groups.length })
            : t('tabs.windowCount', { count: windowGroups.length })}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip title={t('cleanup.smartTooltip')}>
          <span>
            <Button
              size="small"
              variant="outlined"
              color="primary"
              onClick={() => void runSmartCleanup(true)}
              disabled={smartLoading || tabs.length === 0}
              startIcon={<AutoAwesomeIcon sx={{ fontSize: 16 }} />}
              sx={{
                textTransform: 'none',
                borderRadius: 999,
                fontSize: 12,
                py: 0.25,
                px: 1.25,
              }}
            >
              {t('cleanup.smartButton')}
            </Button>
          </span>
        </Tooltip>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={mode}
          onChange={(_, v) => {
            if (v) setMode(v as GroupMode);
          }}
          sx={{
            '& .MuiToggleButton-root': {
              textTransform: 'none',
              borderRadius: '999px !important',
              px: 1.25,
              py: 0.25,
              gap: 0.5,
              fontSize: 12,
            },
          }}
        >
          <ToggleButton value="domain" aria-label={t('tabs.byDomain')}>
            <LanguageIcon sx={{ fontSize: 16 }} />
            <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
              {t('tabs.byDomain')}
            </Box>
          </ToggleButton>
          <ToggleButton value="window" aria-label={t('tabs.byWindow')}>
            <WindowIcon sx={{ fontSize: 16 }} />
            <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
              {t('tabs.byWindow')}
            </Box>
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>

      {/* Inline filter — dashboard search lives in the navbar (⌘K), but a
          local filter for "just my open tabs" stays handy here. */}
      {externalFilter === undefined && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            px: 1.5,
            py: 0.75,
            mb: 1.5,
            borderRadius: 999,
            backgroundColor: 'var(--mui-palette-action-hover)',
            border: '1px solid var(--mui-palette-divider)',
            transition: 'background-color 200ms cubic-bezier(0.2, 0, 0, 1)',
            '&:focus-within': {
              backgroundColor: 'var(--mui-palette-background-paper)',
              borderColor: 'var(--mui-palette-primary-main)',
            },
          }}
        >
          <SearchIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
          <InputBase
            fullWidth
            value={internalFilter}
            placeholder={t('search.placeholder')}
            onChange={(e) => setInternalFilter(e.target.value)}
            sx={{ fontSize: 13 }}
          />
          {internalFilter && (
            <IconButton size="small" onClick={() => setInternalFilter('')} sx={{ p: 0.25 }}>
              <CloseIcon sx={{ fontSize: 16 }} />
            </IconButton>
          )}
        </Box>
      )}

      {selected.size > 0 && (
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          flexWrap="wrap"
          useFlexGap
          sx={{ mb: 1.5 }}
        >
          <Chip
            size="small"
            label={t('tabs.selected', { count: selected.size })}
            color="primary"
          />
          <Button size="small" onClick={clearSelection} variant="text">
            {t('tabs.clearSelection')}
          </Button>
          <Button
            size="small"
            onClick={stashSelected}
            variant="outlined"
            startIcon={<InventoryIcon sx={{ fontSize: 16 }} />}
          >
            {t('tabs.stashSelected')}
          </Button>
          <Button
            size="small"
            onClick={closeSelected}
            variant="contained"
            color="primary"
            startIcon={<CloseIcon sx={{ fontSize: 16 }} />}
          >
            {t('tabs.closeSelected')}
          </Button>
        </Stack>
      )}

      {/* Cleanup suggestions live at the top of the tab list — this is a
          high-frequency action, so it gets folded in here rather than
          banished to a separate section below. */}
      <InlineCleanupCard />

      {cardGroups.length === 0 ? (
        <Card sx={{ p: 4, textAlign: 'center' }}>
          <Typography color="text.secondary" variant="body2">
            {t('tabs.empty')}
          </Typography>
        </Card>
      ) : (
        <Box
          ref={containerRef}
          onKeyDown={onListKeyDown}
          tabIndex={0}
          role="listbox"
          aria-label={t('sections.openTabs')}
          sx={{
            display: 'grid',
            gap: sizes.cardSpacing,
            gridTemplateColumns: sizes.innerGridCols,
            outline: 'none',
            '&:focus-visible': {
              boxShadow: '0 0 0 2px var(--mui-palette-primary-main)',
              borderRadius: 4,
            },
          }}
        >
          {cardGroups.map((group) => {
            const accent =
              group.accentHue !== undefined
                ? `hsl(${group.accentHue}, 70%, 55%)`
                : undefined;
            return (
              <Card
                key={group.key}
                sx={{
                  p: sizes.cardPadding,
                  display: 'flex',
                  flexDirection: 'column',
                  position: 'relative',
                  overflow: 'hidden',
                }}
              >
                {accent && (
                  <Box
                    aria-hidden
                    sx={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: 3,
                      backgroundColor: accent,
                    }}
                  />
                )}
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: sizes.headerGap,
                    mb: 1,
                    pl: accent ? 0.5 : 0,
                  }}
                >
                  {group.showFavicon ? (
                    <Avatar
                      src={faviconUrl(group.tabs[0])}
                      variant="rounded"
                      sx={{
                        width: sizes.headerFavicon,
                        height: sizes.headerFavicon,
                        bgcolor: 'transparent',
                      }}
                    />
                  ) : (
                    <Avatar
                      variant="rounded"
                      sx={{
                        width: sizes.headerFavicon,
                        height: sizes.headerFavicon,
                        bgcolor: accent
                          ? `hsla(${group.accentHue}, 70%, 55%, 0.15)`
                          : 'var(--mui-palette-action-hover)',
                        color: accent,
                      }}
                    >
                      <LayersIcon sx={{ fontSize: dense ? 14 : 18 }} />
                    </Avatar>
                  )}
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography
                      sx={{
                        fontSize: sizes.domainFontSize,
                        fontWeight: 500,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        lineHeight: 1.2,
                      }}
                    >
                      {group.label}
                    </Typography>
                    <Typography
                      sx={{
                        fontSize: sizes.captionFontSize,
                        color: 'text.secondary',
                        display: 'block',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        lineHeight: 1.2,
                      }}
                      title={group.subLabel}
                    >
                      {mode === 'window' && group.subLabel
                        ? group.subLabel
                        : t('tabs.count', { count: group.tabs.length })}
                    </Typography>
                  </Box>
                  <Tooltip title={t('tabs.selectAll')}>
                    <Checkbox
                      size="small"
                      sx={{ p: 0.25 }}
                      checked={group.tabs.every(
                        (tb) => tb.id !== undefined && selected.has(tb.id),
                      )}
                      indeterminate={
                        group.tabs.some(
                          (tb) => tb.id !== undefined && selected.has(tb.id),
                        ) &&
                        !group.tabs.every(
                          (tb) => tb.id !== undefined && selected.has(tb.id),
                        )
                      }
                      onChange={() => selectGroup(group.tabs)}
                    />
                  </Tooltip>
                  <Tooltip title={t('tabs.stashAllInDomain')}>
                    <IconButton
                      size="small"
                      onClick={() => stashGroup(group.tabs)}
                      sx={{ p: 0.5 }}
                    >
                      <InventoryIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title={t('tabs.closeAllInDomain')}>
                    <IconButton
                      size="small"
                      onClick={() => closeGroup(group.tabs)}
                      sx={{ p: 0.5 }}
                    >
                      <CloseIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                </Box>
                <Stack spacing={0} sx={{ flex: 1 }}>
                  {group.tabs.map((tab) => {
                    const isFocused = focusedTabId === tab.id;
                    const isAiSuggested = tab.id !== undefined && aiSelected.has(tab.id);
                    return (
                      <Box
                        key={tab.id}
                        role="option"
                        aria-selected={tab.id !== undefined && selected.has(tab.id)}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: sizes.rowGap,
                          px: sizes.rowPaddingX,
                          py: sizes.rowPaddingY,
                          borderRadius: 1.5,
                          position: 'relative',
                          transition:
                            'background-color 150ms cubic-bezier(0.2, 0, 0, 1), box-shadow 220ms ease',
                          backgroundColor: isFocused
                            ? 'var(--mui-palette-action-selected)'
                            : isAiSuggested
                              ? 'rgba(194, 65, 12, 0.06)'
                              : 'transparent',
                          outline: isFocused
                            ? '2px solid var(--mui-palette-primary-main)'
                            : 'none',
                          outlineOffset: -2,
                          // Coral micro-glow marking AI-suggested tabs.
                          // Persistent until the user closes/clears, even
                          // if they uncheck the row — that's the visual
                          // contract for "model proposed this".
                          boxShadow: isAiSuggested
                            ? '0 0 0 1px rgba(194, 65, 12, 0.32), 0 0 12px rgba(194, 65, 12, 0.30)'
                            : 'none',
                          animation: isAiSuggested
                            ? 'augur-ai-glow 2.4s ease-in-out infinite'
                            : 'none',
                          '@keyframes augur-ai-glow': {
                            '0%, 100%': {
                              boxShadow:
                                '0 0 0 1px rgba(194, 65, 12, 0.30), 0 0 10px rgba(194, 65, 12, 0.22)',
                            },
                            '50%': {
                              boxShadow:
                                '0 0 0 1px rgba(194, 65, 12, 0.40), 0 0 16px rgba(194, 65, 12, 0.36)',
                            },
                          },
                          '&:hover': {
                            backgroundColor: 'var(--mui-palette-action-hover)',
                          },
                        }}
                        onMouseEnter={() => tab.id !== undefined && setFocusedTabId(tab.id)}
                      >
                        <Checkbox
                          size="small"
                          checked={tab.id !== undefined && selected.has(tab.id)}
                          onChange={() => tab.id !== undefined && toggle(tab.id)}
                          sx={{ p: 0.25 }}
                        />
                        {tab.pinned && (
                          <PushPinIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                        )}
                        {(mode === 'window' || dense) && tab.favIconUrl && (
                          <Avatar
                            src={tab.favIconUrl}
                            variant="rounded"
                            sx={{
                              width: sizes.rowFavicon,
                              height: sizes.rowFavicon,
                              bgcolor: 'transparent',
                            }}
                          />
                        )}
                        <Typography
                          sx={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: sizes.rowFontSize,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            cursor: 'pointer',
                          }}
                          title={tab.title ?? tab.url}
                          onClick={() => activateTab(tab)}
                        >
                          {tab.title || tab.url}
                        </Typography>
                        <Tooltip
                          title={
                            tab.url && isPinned(tab.url)
                              ? t('pins.unpin')
                              : t('pins.pin')
                          }
                        >
                          <IconButton
                            size="small"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!tab.url) return;
                              if (isPinned(tab.url)) {
                                void pinRemove(tab.url);
                              } else {
                                void pinAdd({
                                  url: tab.url,
                                  title: tab.title ?? tab.url,
                                  favIconUrl: tab.favIconUrl,
                                });
                              }
                            }}
                            sx={{
                              p: 0.25,
                              color:
                                tab.url && isPinned(tab.url) ? 'primary.main' : 'inherit',
                            }}
                          >
                            {tab.url && isPinned(tab.url) ? (
                              <PushPinIcon sx={{ fontSize: 14 }} />
                            ) : (
                              <PushPinOutlinedIcon sx={{ fontSize: 14 }} />
                            )}
                          </IconButton>
                        </Tooltip>
                        <Tooltip title={tab.url ?? ''}>
                          <IconButton
                            size="small"
                            onClick={() => activateTab(tab)}
                            sx={{ p: 0.25 }}
                          >
                            <OpenInNewIcon sx={{ fontSize: 14 }} />
                          </IconButton>
                        </Tooltip>
                        <IconButton
                          size="small"
                          onClick={() => tab.id !== undefined && closeTabs([tab.id])}
                          sx={{ p: 0.25 }}
                          aria-label={t('tabs.closeOne')}
                        >
                          <CloseIcon sx={{ fontSize: 14 }} />
                        </IconButton>
                      </Box>
                    );
                  })}
                </Stack>
              </Card>
            );
          })}
        </Box>
      )}

      {!dense && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ mt: 2, display: 'block' }}
        >
          {t('tabs.keyboardHint')}
        </Typography>
      )}
    </Box>
  );
}
