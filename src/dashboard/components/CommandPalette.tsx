import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  Box,
  Chip,
  Dialog,
  IconButton,
  InputBase,
  List,
  ListItemButton,
  ListSubheader,
  Stack,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import HistoryIcon from '@mui/icons-material/History';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import TabIcon from '@mui/icons-material/Tab';
import BoltIcon from '@mui/icons-material/Bolt';
import CloseIcon from '@mui/icons-material/Close';
import { activateTab } from '../hooks/useTabs';
import { openUrlViaSw, rebuildAggregates } from '../api/recommendations';

interface PaletteCommand {
  id: string;
  kind: 'command';
  title: string;
  hint?: string;
  run: () => void | Promise<void>;
}

interface PaletteTab {
  kind: 'tab';
  id: string;
  tab: chrome.tabs.Tab;
}

interface PaletteHistory {
  kind: 'history';
  id: string;
  url: string;
  title: string;
  visitCount: number;
}

interface PaletteBookmark {
  kind: 'bookmark';
  id: string;
  url: string;
  title: string;
  path: string;
}

type PaletteItem = PaletteCommand | PaletteTab | PaletteHistory | PaletteBookmark;

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}

function favicon(url: string): string {
  try {
    return `https://www.google.com/s2/favicons?sz=64&domain=${new URL(url).hostname}`;
  } catch {
    return '';
  }
}

export function CommandPalette({ open, onClose, onOpenSettings }: Props) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const [tabs, setTabs] = useState<chrome.tabs.Tab[]>([]);
  const [history, setHistory] = useState<chrome.history.HistoryItem[]>([]);
  const [bookmarks, setBookmarks] = useState<chrome.bookmarks.BookmarkTreeNode[]>([]);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Reset state on open.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHighlight(0);
    if (chrome?.tabs?.query) {
      chrome.tabs.query({}, (t) => setTabs(t));
    }
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  // Live history + bookmarks search.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setHistory([]);
      setBookmarks([]);
      return;
    }
    const handle = window.setTimeout(() => {
      try {
        chrome.history?.search?.(
          { text: q, maxResults: 8, startTime: 0 },
          (items) => setHistory(items),
        );
        chrome.bookmarks?.search?.(q, (items) => setBookmarks(items.slice(0, 8)));
      } catch {
        // No-op when not running as extension.
      }
    }, 120);
    return () => window.clearTimeout(handle);
  }, [open, query]);

  const commands: PaletteCommand[] = useMemo(
    () => [
      {
        id: 'cmd:settings',
        kind: 'command',
        title: t('commands.openSettings'),
        hint: t('commands.openSettingsHint'),
        run: () => {
          onClose();
          onOpenSettings();
        },
      },
      {
        id: 'cmd:rebuild',
        kind: 'command',
        title: t('commands.rebuildAggregates'),
        hint: t('commands.rebuildAggregatesHint'),
        run: async () => {
          await rebuildAggregates();
          onClose();
        },
      },
      {
        id: 'cmd:lang',
        kind: 'command',
        title: t('commands.toggleLanguage'),
        hint: t('commands.toggleLanguageHint'),
        run: () => {
          const next = i18n.resolvedLanguage === 'zh' ? 'en' : 'zh';
          void i18n.changeLanguage(next);
          onClose();
        },
      },
    ],
    [i18n, onClose, onOpenSettings, t],
  );

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase();
    const matchedCommands = q
      ? commands.filter((c) => c.title.toLowerCase().includes(q))
      : commands;

    const matchedTabs = q
      ? tabs.filter(
          (tab) =>
            (tab.title ?? '').toLowerCase().includes(q) ||
            (tab.url ?? '').toLowerCase().includes(q),
        )
      : tabs.slice(0, 6);

    const ts: PaletteTab[] = matchedTabs.slice(0, 8).map((tab) => ({
      kind: 'tab',
      id: `tab:${tab.id}`,
      tab,
    }));

    const hist: PaletteHistory[] = history
      .filter((h) => !!h.url)
      .map((h) => ({
        kind: 'history',
        id: `history:${h.id}`,
        url: h.url ?? '',
        title: h.title || h.url || '',
        visitCount: h.visitCount ?? 0,
      }));

    const bms: PaletteBookmark[] = bookmarks
      .filter((b) => !!b.url)
      .map((b) => ({
        kind: 'bookmark',
        id: `bm:${b.id}`,
        url: b.url ?? '',
        title: b.title || b.url || '',
        path: '',
      }));

    return [...ts, ...matchedCommands, ...hist, ...bms];
  }, [bookmarks, commands, history, query, tabs]);

  // Keep highlight in range as items shift.
  useEffect(() => {
    setHighlight((h) => Math.max(0, Math.min(h, items.length - 1)));
  }, [items.length]);

  const runItem = async (item: PaletteItem) => {
    if (item.kind === 'tab') {
      await activateTab(item.tab);
      onClose();
    } else if (item.kind === 'history' || item.kind === 'bookmark') {
      await openUrlViaSw(item.url);
      onClose();
    } else {
      await item.run();
    }
  };

  const onKeyDown = async (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(items.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[highlight];
      if (item) await runItem(item);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  const renderItem = (item: PaletteItem, idx: number) => {
    const selected = idx === highlight;
    let icon: React.ReactNode = null;
    let title = '';
    let subtitle = '';
    let badge: React.ReactNode = null;

    if (item.kind === 'tab') {
      icon = (
        <Avatar
          src={item.tab.favIconUrl ?? favicon(item.tab.url ?? '')}
          variant="rounded"
          sx={{ width: 24, height: 24, bgcolor: 'transparent' }}
        />
      );
      title = item.tab.title || item.tab.url || '';
      subtitle = item.tab.url ?? '';
      badge = (
        <Chip
          icon={<TabIcon fontSize="small" />}
          label={t('palette.openTab')}
          size="small"
          sx={{ height: 20 }}
        />
      );
    } else if (item.kind === 'command') {
      icon = (
        <Avatar
          variant="rounded"
          sx={{
            width: 24,
            height: 24,
            bgcolor: 'var(--mui-palette-primary-light)',
            color: 'var(--mui-palette-primary-dark)',
          }}
        >
          <BoltIcon fontSize="small" />
        </Avatar>
      );
      title = item.title;
      subtitle = item.hint ?? '';
      badge = <Chip label={t('palette.command')} size="small" sx={{ height: 20 }} />;
    } else if (item.kind === 'history') {
      icon = (
        <Avatar
          src={favicon(item.url)}
          variant="rounded"
          sx={{ width: 24, height: 24, bgcolor: 'transparent' }}
        />
      );
      title = item.title;
      subtitle = item.url;
      badge = (
        <Chip
          icon={<HistoryIcon fontSize="small" />}
          label={t('palette.history')}
          size="small"
          sx={{ height: 20 }}
        />
      );
    } else {
      icon = (
        <Avatar
          src={favicon(item.url)}
          variant="rounded"
          sx={{ width: 24, height: 24, bgcolor: 'transparent' }}
        />
      );
      title = item.title;
      subtitle = item.url;
      badge = (
        <Chip
          icon={<StarBorderIcon fontSize="small" />}
          label={t('palette.bookmark')}
          size="small"
          sx={{ height: 20 }}
        />
      );
    }

    return (
      <ListItemButton
        key={item.id}
        selected={selected}
        onMouseEnter={() => setHighlight(idx)}
        onClick={() => void runItem(item)}
        sx={{
          gap: 1.5,
          py: 1,
          px: 2,
          borderRadius: 2,
          mx: 1,
          '&.Mui-selected': {
            backgroundColor: 'var(--mui-palette-action-selected)',
          },
        }}
      >
        {icon}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            variant="body2"
            sx={{
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {title}
          </Typography>
          {subtitle && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{
                display: 'block',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {subtitle}
            </Typography>
          )}
        </Box>
        {badge}
      </ListItemButton>
    );
  };

  // Group rendering by kind so users can scan.
  const groups: Array<{ heading: string; items: Array<{ item: PaletteItem; idx: number }> }> = [];
  const pushGroup = (heading: string, kinds: PaletteItem['kind'][]) => {
    const filtered = items
      .map((item, idx) => ({ item, idx }))
      .filter((x) => kinds.includes(x.item.kind));
    if (filtered.length > 0) groups.push({ heading, items: filtered });
  };
  pushGroup(t('palette.tabsGroup'), ['tab']);
  pushGroup(t('palette.commandsGroup'), ['command']);
  pushGroup(t('palette.historyGroup'), ['history']);
  pushGroup(t('palette.bookmarksGroup'), ['bookmark']);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      slotProps={{
        paper: {
          sx: {
            borderRadius: 4,
            mt: 8,
            alignSelf: 'flex-start',
            overflow: 'hidden',
          },
        },
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          px: 2,
          py: 1.5,
          borderBottom: '1px solid var(--mui-palette-divider)',
        }}
      >
        <SearchIcon sx={{ color: 'text.secondary' }} />
        <InputBase
          inputRef={inputRef}
          fullWidth
          autoFocus
          value={query}
          placeholder={t('palette.placeholder')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          sx={{ fontSize: '1rem' }}
        />
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Chip label="↑↓" size="small" sx={{ height: 22 }} />
          <Chip label="↵" size="small" sx={{ height: 22 }} />
          <Chip label="Esc" size="small" sx={{ height: 22 }} />
        </Stack>
        <IconButton size="small" onClick={onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>
      {items.length === 0 ? (
        <Box sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            {t('palette.empty')}
          </Typography>
        </Box>
      ) : (
        <Box sx={{ maxHeight: '60vh', overflowY: 'auto', py: 1 }}>
          <List ref={listRef} sx={{ py: 0 }} subheader={<li />}>
            {groups.map((g) => (
              <li key={g.heading}>
                <ul style={{ padding: 0 }}>
                  <ListSubheader
                    disableSticky={false}
                    sx={{
                      bgcolor: 'transparent',
                      lineHeight: 1.5,
                      fontSize: '0.7rem',
                      letterSpacing: '0.05em',
                      textTransform: 'uppercase',
                      color: 'text.secondary',
                      px: 3,
                    }}
                  >
                    {g.heading}
                  </ListSubheader>
                  {g.items.map(({ item, idx }) => renderItem(item, idx))}
                </ul>
              </li>
            ))}
          </List>
        </Box>
      )}
    </Dialog>
  );
}
