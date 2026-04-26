import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  Box,
  Button,
  Card,
  Checkbox,
  Chip,
  IconButton,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PushPinIcon from '@mui/icons-material/PushPin';
import InventoryIcon from '@mui/icons-material/Inventory2';
import LayersIcon from '@mui/icons-material/Layers';
import LanguageIcon from '@mui/icons-material/Language';
import WindowIcon from '@mui/icons-material/Window';
import { activateTab, closeTabs, useTabs } from '../hooks/useTabs';
import { stashItems } from '../api/recommendations';
import { notifyStashChanged } from './StashSection';
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

export function TabWall({ filter }: { filter: string }) {
  const { t } = useTranslation();
  const { groups, windowGroups, tabs } = useTabs();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<GroupMode>(() => {
    const saved = (typeof localStorage !== 'undefined'
      ? (localStorage.getItem('chromehomepage:tabWallMode') as GroupMode | null)
      : null);
    return saved === 'window' ? 'window' : 'domain';
  });
  const [focusedTabId, setFocusedTabId] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem('chromehomepage:tabWallMode', mode);
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

  const closeSelected = async () => {
    const ids = Array.from(selected);
    await closeTabs(ids);
    setSelected(new Set());
    if (ids.length > 0) {
      toast({
        message: t('toasts.tabsClosed', { count: ids.length }),
        severity: 'success',
      });
    }
  };

  const closeGroup = async (groupTabs: chrome.tabs.Tab[]) => {
    const ids = groupTabs.map((t) => t.id).filter((x): x is number => x !== undefined);
    await closeTabs(ids);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    if (ids.length > 0) {
      toast({
        message: t('toasts.tabsClosed', { count: ids.length }),
        severity: 'success',
      });
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
    toast({
      message: t('toasts.tabsStashed', { count: items.length }),
      severity: 'success',
    });
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

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 2,
          gap: 2,
          flexWrap: 'wrap',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, flexWrap: 'wrap' }}>
          <Typography variant="h5">{t('sections.openTabs')}</Typography>
          <Typography variant="body2" color="text.secondary">
            {t('tabs.count', { count: tabs.length })} ·{' '}
            {mode === 'domain'
              ? t('tabs.domainCount', { count: groups.length })
              : t('tabs.windowCount', { count: windowGroups.length })}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
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
                px: 1.5,
                py: 0.5,
                gap: 0.5,
              },
            }}
          >
            <ToggleButton value="domain" aria-label={t('tabs.byDomain')}>
              <LanguageIcon fontSize="small" />
              <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
                {t('tabs.byDomain')}
              </Box>
            </ToggleButton>
            <ToggleButton value="window" aria-label={t('tabs.byWindow')}>
              <WindowIcon fontSize="small" />
              <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
                {t('tabs.byWindow')}
              </Box>
            </ToggleButton>
          </ToggleButtonGroup>

          {selected.size > 0 && (
            <>
              <Chip label={t('tabs.selected', { count: selected.size })} color="primary" />
              <Button onClick={() => setSelected(new Set())} variant="text">
                {t('tabs.clearSelection')}
              </Button>
              <Button
                onClick={stashSelected}
                variant="outlined"
                startIcon={<InventoryIcon />}
              >
                {t('tabs.stashSelected')}
              </Button>
              <Button
                onClick={closeSelected}
                variant="contained"
                color="primary"
                startIcon={<CloseIcon />}
              >
                {t('tabs.closeSelected')}
              </Button>
            </>
          )}
        </Stack>
      </Box>

      {cardGroups.length === 0 ? (
        <Card sx={{ p: 4, textAlign: 'center' }}>
          <Typography color="text.secondary">{t('tabs.empty')}</Typography>
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
            gap: 2,
            gridTemplateColumns: {
              xs: '1fr',
              sm: 'repeat(2, 1fr)',
              lg: 'repeat(3, 1fr)',
              xl: 'repeat(4, 1fr)',
            },
            outline: 'none',
            '&:focus-visible': {
              boxShadow: '0 0 0 2px var(--mui-palette-primary-main)',
              borderRadius: 4,
            },
          }}
        >
          {cardGroups.map((group) => {
            const isWindow = mode === 'window';
            const accent =
              group.accentHue !== undefined
                ? `hsl(${group.accentHue}, 70%, 55%)`
                : undefined;
            return (
              <Card
                key={group.key}
                sx={{
                  p: 2,
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
                      width: 4,
                      backgroundColor: accent,
                    }}
                  />
                )}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5, pl: accent ? 0.5 : 0 }}>
                  {group.showFavicon ? (
                    <Avatar
                      src={faviconUrl(group.tabs[0])}
                      variant="rounded"
                      sx={{ width: 32, height: 32, bgcolor: 'transparent' }}
                    />
                  ) : (
                    <Avatar
                      variant="rounded"
                      sx={{
                        width: 32,
                        height: 32,
                        bgcolor: accent ? `hsla(${group.accentHue}, 70%, 55%, 0.15)` : 'var(--mui-palette-action-hover)',
                        color: accent,
                      }}
                    >
                      <LayersIcon fontSize="small" />
                    </Avatar>
                  )}
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography
                      variant="subtitle1"
                      sx={{
                        fontWeight: 500,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {group.label}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{
                        display: 'block',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={group.subLabel}
                    >
                      {isWindow && group.subLabel
                        ? group.subLabel
                        : t('tabs.count', { count: group.tabs.length })}
                    </Typography>
                  </Box>
                  <Tooltip title={t('tabs.selectAll')}>
                    <Checkbox
                      size="small"
                      checked={group.tabs.every(
                        (tb) => tb.id !== undefined && selected.has(tb.id),
                      )}
                      indeterminate={
                        group.tabs.some((tb) => tb.id !== undefined && selected.has(tb.id)) &&
                        !group.tabs.every((tb) => tb.id !== undefined && selected.has(tb.id))
                      }
                      onChange={() => selectGroup(group.tabs)}
                    />
                  </Tooltip>
                  <Tooltip title={t('tabs.stashAllInDomain')}>
                    <IconButton size="small" onClick={() => stashGroup(group.tabs)}>
                      <InventoryIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title={t('tabs.closeAllInDomain')}>
                    <IconButton size="small" onClick={() => closeGroup(group.tabs)}>
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Box>
                <Stack spacing={0.5} sx={{ flex: 1 }}>
                  {group.tabs.map((tab) => {
                    const isFocused = focusedTabId === tab.id;
                    return (
                      <Box
                        key={tab.id}
                        role="option"
                        aria-selected={tab.id !== undefined && selected.has(tab.id)}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 1,
                          px: 1,
                          py: 0.75,
                          borderRadius: 2,
                          transition: 'background-color 150ms cubic-bezier(0.2, 0, 0, 1)',
                          backgroundColor: isFocused
                            ? 'var(--mui-palette-action-selected)'
                            : 'transparent',
                          outline: isFocused
                            ? '2px solid var(--mui-palette-primary-main)'
                            : 'none',
                          outlineOffset: -2,
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
                          sx={{ p: 0.5 }}
                        />
                        {tab.pinned && (
                          <PushPinIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                        )}
                        {mode === 'window' && tab.favIconUrl && (
                          <Avatar
                            src={tab.favIconUrl}
                            variant="rounded"
                            sx={{ width: 16, height: 16, bgcolor: 'transparent' }}
                          />
                        )}
                        <Typography
                          variant="body2"
                          sx={{
                            flex: 1,
                            minWidth: 0,
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
                        <Tooltip title={tab.url ?? ''}>
                          <IconButton size="small" onClick={() => activateTab(tab)} sx={{ p: 0.5 }}>
                            <OpenInNewIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <IconButton
                          size="small"
                          onClick={() => tab.id !== undefined && closeTabs([tab.id])}
                          sx={{ p: 0.5 }}
                          aria-label={t('tabs.closeOne')}
                        >
                          <CloseIcon fontSize="small" />
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

      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ mt: 2, display: 'block' }}
      >
        {t('tabs.keyboardHint')}
      </Typography>
    </Box>
  );
}
