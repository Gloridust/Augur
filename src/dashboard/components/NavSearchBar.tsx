import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  ClickAwayListener,
  Divider,
  IconButton,
  InputBase,
  ListItemButton,
  Menu,
  MenuItem,
  Paper,
  Popper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import HistoryIcon from '@mui/icons-material/History';
import PublicIcon from '@mui/icons-material/Public';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import SpaIcon from '@mui/icons-material/Spa';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  searchUrlFor,
  useSearchEngine,
  type SearchEngine,
} from '../hooks/useSearchEngine';
import { useRecentSearches } from '../hooks/useRecentSearches';
import { useSearchSuggestions } from '../hooks/useSearchSuggestions';
import { logUiEvent } from '../api/recommendations';
import { EngineGlyph } from './EngineGlyph';
import { activateTab } from '../hooks/useTabs';
import { useZenMode } from '../hooks/useZenMode';
import { useLauncherResults, type LauncherHit } from '../search/useLauncherResults';
import { siteSearchFor, type SiteSearch } from '../search/sites';

type Row =
  | { type: 'hit'; hit: LauncherHit }
  | { type: 'goto'; url: string }
  | { type: 'web'; value: string }
  | { type: 'recent'; value: string }
  | { type: 'suggest'; value: string }
  | { type: 'siteHint'; site: SiteSearch }
  | { type: 'zen' };

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

// "github.com/foo", "localhost:5173", "https://…" — not "react table".
function asUrl(q: string): string | null {
  const t = q.trim();
  if (!t || /\s/.test(t)) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(t)) return `https://${t}`;
  return null;
}

// A title/domain match this strong is what the user is looking for: Enter
// goes to it. Weaker matches stay below the web search.
const STRONG_HIT = 80;

interface Props {
  // 'hero': Zen mode's centred, larger launcher.
  variant?: 'nav' | 'hero';
}

export function NavSearchBar({ variant = 'nav' }: Props) {
  const { t } = useTranslation();
  const [engine, setEngine] = useSearchEngine();
  const { recent, add: addRecent, remove: removeRecent } = useRecentSearches();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<SiteSearch | null>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [engineMenu, setEngineMenu] = useState<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const suggestions = useSearchSuggestions(query);
  const hits = useLauncherResults(scope ? '' : query, open);
  const [zen, setZenMode] = useZenMode();
  const engineName = engine === 'google' ? 'Google' : 'Bing';

  const rows: Row[] = useMemo(() => {
    const q = query.trim();
    if (scope) {
      return q ? [{ type: 'web', value: q }, ...suggestions.filter((s) => s !== q).map<Row>((value) => ({ type: 'suggest', value }))] : [];
    }
    if (q === '/' || '/zen'.startsWith(q.toLowerCase()) && q.startsWith('/')) return [{ type: 'zen' }];
    const out: Row[] = [];
    const site = /^[a-z]+$/i.test(q) ? siteSearchFor(q) : undefined;
    if (site) out.push({ type: 'siteHint', site });
    const url = asUrl(q);
    if (url) out.push({ type: 'goto', url });
    const strong = hits.filter((h) => h.score >= STRONG_HIT && h.kind !== 'history');
    const rest = hits.filter((h) => !strong.includes(h));
    out.push(...strong.map<Row>((hit) => ({ type: 'hit', hit })));
    if (q && !url) out.push({ type: 'web', value: q });
    out.push(...rest.map<Row>((hit) => ({ type: 'hit', hit })));
    const lower = q.toLowerCase();
    const matchingRecent = (q ? recent.filter((r) => r.toLowerCase().includes(lower) && r.toLowerCase() !== lower) : recent).slice(0, q ? 3 : 6);
    const seen = new Set([lower, ...matchingRecent.map((r) => r.toLowerCase())]);
    out.push(...matchingRecent.map<Row>((value) => ({ type: 'recent', value })));
    out.push(
      ...suggestions
        .filter((s) => !seen.has(s.toLowerCase()))
        .slice(0, 5)
        .map<Row>((value) => ({ type: 'suggest', value })),
    );
    return out;
  }, [query, scope, hits, recent, suggestions]);

  useEffect(() => {
    if (highlight >= rows.length) setHighlight(Math.max(0, rows.length - 1));
  }, [highlight, rows.length]);

  const focusInput = () => {
    inputRef.current?.focus();
    inputRef.current?.select();
    setOpen(true);
  };

  // ⌘K / Ctrl+K from anywhere on the dashboard; #launcher when the global
  // shortcut opened this page.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        focusInput();
      }
    };
    window.addEventListener('keydown', handler);
    if (location.hash === '#launcher') {
      history.replaceState(null, '', location.pathname + location.search);
      requestAnimationFrame(focusInput);
    }
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const go = (url: string, newTab: boolean) => {
    setOpen(false);
    if (newTab) window.open(url, '_blank');
    else window.location.href = url;
  };

  const search = (raw: string, newTab: boolean) => {
    const q = raw.trim();
    if (!q) return;
    addRecent(q);
    logUiEvent({ type: 'search_executed', query: q, meta: { engine: scope?.key ?? engine, openInNewTab: newTab } });
    go(scope ? scope.url(q) : searchUrlFor(engine, q), newTab);
  };

  const activate = (row: Row | undefined, newTab: boolean) => {
    if (!row) return search(query, newTab);
    switch (row.type) {
      case 'hit':
        logUiEvent({ type: 'launcher_opened', domain: row.hit.domain, meta: { kind: row.hit.kind } });
        if (row.hit.kind === 'tab' && row.hit.tab && !newTab) {
          setOpen(false);
          setQuery('');
          void activateTab(row.hit.tab);
        } else {
          go(row.hit.url, newTab);
        }
        return;
      case 'goto':
        return go(row.url, newTab);
      case 'siteHint':
        setScope(row.site);
        setQuery('');
        return;
      case 'zen':
        setZenMode(!zen);
        setQuery('');
        setOpen(false);
        return;
      default:
        return search(row.value, newTab);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(rows.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(open ? rows[highlight] : undefined, e.metaKey || e.ctrlKey);
    } else if (e.key === 'Tab' && !scope && !e.shiftKey) {
      const site = siteSearchFor(query.trim());
      if (site) {
        e.preventDefault();
        setScope(site);
        setQuery('');
        setHighlight(0);
      }
    } else if (e.key === 'Backspace' && scope && query === '') {
      e.preventDefault();
      setScope(null);
    } else if (e.key === 'Escape') {
      if (scope) setScope(null);
      else {
        setOpen(false);
        inputRef.current?.blur();
      }
    }
  };

  const pickEngine = (next: SearchEngine) => {
    setEngine(next);
    setEngineMenu(null);
    inputRef.current?.focus();
  };

  const hero = variant === 'hero';
  const sectionOf = (row: Row): string | null =>
    row.type === 'hit'
      ? t(`launcher.section.${row.hit.kind}`)
      : row.type === 'recent'
        ? t('launcher.section.recent')
        : row.type === 'suggest'
          ? t('launcher.section.suggest')
          : null;

  const favicon = (url: string, explicit?: string) => {
    if (explicit) return explicit;
    try {
      return `https://www.google.com/s2/favicons?sz=32&domain=${new URL(url).hostname}`;
    } catch {
      return undefined;
    }
  };

  const rowIcon = (row: Row) => {
    const iconSx = { fontSize: 16, color: 'text.secondary', flexShrink: 0 } as const;
    switch (row.type) {
      case 'hit':
        return (
          <Box
            component="img"
            src={favicon(row.hit.url, row.hit.favIconUrl)}
            alt=""
            sx={{ width: 16, height: 16, borderRadius: 0.5, flexShrink: 0 }}
            onError={(e: React.SyntheticEvent<HTMLImageElement>) => (e.currentTarget.style.visibility = 'hidden')}
          />
        );
      case 'goto':
        return <PublicIcon sx={iconSx} />;
      case 'siteHint':
        return <TravelExploreIcon sx={{ ...iconSx, color: 'primary.main' }} />;
      case 'zen':
        return <SpaIcon sx={{ ...iconSx, color: 'primary.main' }} />;
      case 'recent':
        return <HistoryIcon sx={iconSx} />;
      default:
        return <SearchIcon sx={iconSx} />;
    }
  };

  const rowText = (row: Row): { main: string; sub?: string; action?: string } => {
    switch (row.type) {
      case 'hit':
        return {
          main: row.hit.title,
          sub: row.hit.domain,
          action: row.hit.kind === 'tab' ? t('launcher.switch') : t('launcher.open'),
        };
      case 'goto':
        return { main: row.url.replace(/^https?:\/\//, ''), action: t('launcher.go') };
      case 'siteHint':
        return { main: t('launcher.siteHint', { site: row.site.name }), action: 'Tab' };
      case 'zen':
        return { main: zen ? t('launcher.zenOff') : t('launcher.zenOn'), action: '↵' };
      case 'web':
        return { main: row.value, action: t('launcher.searchOn', { engine: scope?.name ?? engineName }) };
      default:
        return { main: row.value };
    }
  };

  return (
    <Box
      ref={containerRef}
      sx={{
        width: hero ? { xs: '100%', sm: 560, md: 640 } : { xs: '100%', sm: 320, md: 440, lg: 520 },
        maxWidth: '100%',
        position: 'relative',
      }}
    >
      <ClickAwayListener onClickAway={() => setOpen(false)}>
        <Box>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              height: hero ? 52 : 40,
              pl: 0.75,
              pr: 1,
              borderRadius: 999,
              backgroundColor: 'var(--mui-palette-background-paper)',
              border: '1px solid var(--mui-palette-divider)',
              boxShadow: hero ? '0 6px 24px -12px rgba(31, 30, 27, 0.28)' : 'none',
              transition: 'border-color 150ms ease, box-shadow 200ms ease',
              '&:focus-within': {
                borderColor: 'var(--mui-palette-primary-main)',
              },
            }}
          >
            <Tooltip title={t('search.engineSwitchHint')}>
              <Box
                onClick={(e) => setEngineMenu(e.currentTarget)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setEngineMenu(e.currentTarget);
                }}
                role="button"
                tabIndex={0}
                aria-label={t('search.engineSwitchHint')}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.25,
                  px: 0.5,
                  py: 0.5,
                  borderRadius: 999,
                  cursor: 'pointer',
                  '&:hover': { backgroundColor: 'var(--mui-palette-action-hover)' },
                }}
              >
                <EngineGlyph engine={engine} size={22} />
                <ExpandMoreIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
              </Box>
            </Tooltip>

            <Divider orientation="vertical" flexItem sx={{ my: 1 }} />

            {scope ? (
              <Box
                component="span"
                sx={{
                  flexShrink: 0,
                  fontSize: 12.5,
                  fontWeight: 500,
                  px: 1,
                  py: 0.25,
                  borderRadius: 999,
                  color: 'primary.dark',
                  backgroundColor: 'var(--mui-palette-primary-light)',
                  whiteSpace: 'nowrap',
                }}
              >
                {scope.name}
              </Box>
            ) : (
              <SearchIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
            )}

            <InputBase
              inputRef={inputRef}
              fullWidth
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
                setHighlight(0);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={onKeyDown}
              placeholder={
                scope
                  ? t('launcher.scopePlaceholder', { site: scope.name })
                  : t('launcher.placeholder')
              }
              inputProps={{
                'aria-label': t('launcher.placeholder'),
                role: 'combobox',
                'aria-expanded': open && rows.length > 0,
                'aria-controls': 'augur-launcher-list',
                'aria-activedescendant': open && rows.length > 0 ? `augur-launcher-row-${highlight}` : undefined,
              }}
              sx={{ fontSize: hero ? 16 : 14 }}
            />

            {query || scope ? (
              <IconButton
                size="small"
                aria-label={t('launcher.clear')}
                onClick={() => {
                  setQuery('');
                  setScope(null);
                  inputRef.current?.focus();
                }}
                sx={{ p: 0.25 }}
              >
                <CloseIcon sx={{ fontSize: 16 }} />
              </IconButton>
            ) : (
              <Box
                component="kbd"
                sx={{
                  display: { xs: 'none', sm: 'block' },
                  fontFamily: 'inherit',
                  fontSize: 11,
                  px: 0.75,
                  py: 0.1,
                  borderRadius: 1,
                  border: '1px solid var(--mui-palette-divider)',
                  backgroundColor: 'var(--mui-palette-action-hover)',
                  color: 'text.secondary',
                  flexShrink: 0,
                }}
              >
                {isMac ? '⌘K' : 'Ctrl+K'}
              </Box>
            )}
          </Box>

          <Popper
            open={open && rows.length > 0}
            anchorEl={containerRef.current}
            placement="bottom-start"
            modifiers={[{ name: 'offset', options: { offset: [0, 6] } }]}
            sx={{ zIndex: (theme) => theme.zIndex.modal }}
          >
            <Paper
              id="augur-launcher-list"
              role="listbox"
              sx={{
                width: containerRef.current?.clientWidth ?? 'auto',
                py: 0.5,
                maxHeight: 440,
                overflowY: 'auto',
                border: '1px solid var(--mui-palette-divider)',
              }}
            >
              {rows.map((row, idx) => {
                const selected = idx === highlight;
                const section = sectionOf(row);
                const showHeader = section !== null && section !== (idx > 0 ? sectionOf(rows[idx - 1]) : null);
                const { main, sub, action } = rowText(row);
                return (
                  <Box key={`${row.type}:${idx}`}>
                    {showHeader && (
                      <Typography
                        component="div"
                        sx={{ px: 1.5, pt: idx === 0 ? 0.5 : 1, pb: 0.25, fontSize: 11, fontWeight: 600, color: 'text.secondary' }}
                      >
                        {section}
                      </Typography>
                    )}
                    <ListItemButton
                      id={`augur-launcher-row-${idx}`}
                      role="option"
                      aria-selected={selected}
                      selected={selected}
                      onMouseEnter={() => setHighlight(idx)}
                      onClick={(e) => activate(row, e.metaKey || e.ctrlKey)}
                      sx={{
                        mx: 0.5,
                        py: 0.6,
                        px: 1,
                        borderRadius: 1.5,
                        gap: 1.25,
                        '&.Mui-selected, &.Mui-selected:hover': {
                          backgroundColor: 'var(--mui-palette-action-selected)',
                        },
                      }}
                    >
                      {rowIcon(row)}
                      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 1 }}>
                        <Typography
                          component="span"
                          sx={{ fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1 }}
                        >
                          {main}
                        </Typography>
                        {sub && (
                          <Typography
                            component="span"
                            sx={{ fontSize: 12, color: 'text.secondary', whiteSpace: 'nowrap', flexShrink: 0 }}
                          >
                            {sub}
                          </Typography>
                        )}
                      </Box>
                      {row.type === 'recent' ? (
                        <Tooltip title={t('search.removeRecent')}>
                          <IconButton
                            size="small"
                            aria-label={t('search.removeRecent')}
                            onClick={(e) => {
                              e.stopPropagation();
                              removeRecent(row.value);
                            }}
                            sx={{ p: 0.25 }}
                          >
                            <CloseIcon sx={{ fontSize: 14 }} />
                          </IconButton>
                        </Tooltip>
                      ) : (
                        action && (
                          <Typography
                            component="span"
                            sx={{
                              fontSize: 11.5,
                              color: 'text.secondary',
                              flexShrink: 0,
                              visibility: selected ? 'visible' : 'hidden',
                            }}
                          >
                            {action}
                          </Typography>
                        )
                      )}
                    </ListItemButton>
                  </Box>
                );
              })}
              <Stack
                direction="row"
                alignItems="center"
                justifyContent="space-between"
                sx={{
                  px: 1.5,
                  pt: 0.75,
                  mt: 0.5,
                  borderTop: '1px solid var(--mui-palette-divider)',
                  color: 'text.secondary',
                  fontSize: 11,
                  gap: 2,
                }}
              >
                <Box>
                  <Box component="span" sx={{ fontWeight: 500, color: 'text.primary' }}>↵</Box>{' '}
                  {t('launcher.footerOpen')}{' '}
                  <Box component="span" sx={{ fontWeight: 500, color: 'text.primary' }}>{isMac ? '⌘' : 'Ctrl'}+↵</Box>{' '}
                  {t('search.newTab')}
                </Box>
                <Box sx={{ whiteSpace: 'nowrap' }}>
                  <Box component="span" sx={{ fontWeight: 500, color: 'text.primary' }}>gh</Box>{' '}
                  <Box component="span" sx={{ fontWeight: 500, color: 'text.primary' }}>Tab</Box>{' '}
                  {t('launcher.footerSite')}
                </Box>
              </Stack>
            </Paper>
          </Popper>
        </Box>
      </ClickAwayListener>

      <Menu
        anchorEl={engineMenu}
        open={Boolean(engineMenu)}
        onClose={() => setEngineMenu(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        <MenuItem selected={engine === 'google'} onClick={() => pickEngine('google')}>
          <EngineGlyph engine="google" size={18} />
          <Box sx={{ ml: 1 }}>Google</Box>
        </MenuItem>
        <MenuItem selected={engine === 'bing'} onClick={() => pickEngine('bing')}>
          <EngineGlyph engine="bing" size={18} />
          <Box sx={{ ml: 1 }}>Bing</Box>
        </MenuItem>
      </Menu>
    </Box>
  );
}
