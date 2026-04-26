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
import NorthEastIcon from '@mui/icons-material/NorthEast';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  searchUrlFor,
  useSearchEngine,
  type SearchEngine,
} from '../hooks/useSearchEngine';
import { useRecentSearches } from '../hooks/useRecentSearches';
import { useSearchSuggestions } from '../hooks/useSearchSuggestions';
import { EngineGlyph } from './EngineGlyph';

interface DropdownItem {
  kind: 'recent' | 'suggest';
  value: string;
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

export function NavSearchBar() {
  const { t } = useTranslation();
  const [engine, setEngine] = useSearchEngine();
  const { recent, add: addRecent, remove: removeRecent } = useRecentSearches();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [engineMenu, setEngineMenu] = useState<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const suggestions = useSearchSuggestions(query);

  // Build the dropdown list — recent first (de-duped), then web suggestions
  // that aren't already shown in the recent block.
  const items: DropdownItem[] = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    const matchingRecent = trimmed
      ? recent.filter((r) => r.toLowerCase().includes(trimmed))
      : recent;
    const seen = new Set(matchingRecent.map((r) => r.toLowerCase()));
    return [
      ...matchingRecent.map<DropdownItem>((value) => ({ kind: 'recent', value })),
      ...suggestions
        .filter((s) => !seen.has(s.toLowerCase()))
        .map<DropdownItem>((value) => ({ kind: 'suggest', value })),
    ];
  }, [query, recent, suggestions]);

  useEffect(() => {
    if (highlight >= items.length) setHighlight(Math.max(0, items.length - 1));
  }, [highlight, items.length]);

  // ⌘K / Ctrl+K to focus the search input from anywhere on the dashboard.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const submit = (raw: string, openInNewTab = false) => {
    const q = raw.trim();
    if (!q) return;
    addRecent(q);
    const url = searchUrlFor(engine, q);
    if (openInNewTab) {
      window.open(url, '_blank');
    } else {
      window.location.href = url;
    }
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(items.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target =
        items.length > 0 && open ? items[highlight]?.value ?? query : query;
      submit(target, e.metaKey || e.ctrlKey);
    } else if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  const pickEngine = (next: SearchEngine) => {
    setEngine(next);
    setEngineMenu(null);
    inputRef.current?.focus();
  };

  return (
    <Box
      ref={containerRef}
      sx={{
        flex: 1,
        maxWidth: 640,
        position: 'relative',
        mx: { xs: 1, md: 2 },
      }}
    >
      <ClickAwayListener onClickAway={() => setOpen(false)}>
        <Box>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              height: 40,
              pl: 0.75,
              pr: 1,
              borderRadius: 999,
              backgroundColor: 'var(--mui-palette-background-paper)',
              border: '1px solid var(--mui-palette-divider)',
              transition: 'border-color 150ms ease, background-color 150ms ease',
              '&:focus-within': {
                borderColor: 'var(--mui-palette-primary-main)',
              },
            }}
          >
            <Tooltip title={t('search.engineSwitchHint')}>
              <Box
                onClick={(e) => setEngineMenu(e.currentTarget)}
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

            <SearchIcon sx={{ fontSize: 18, color: 'text.secondary' }} />

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
              placeholder={t('search.webPlaceholder', {
                engine: engine === 'google' ? 'Google' : 'Bing',
              })}
              sx={{ fontSize: 14 }}
            />

            {query ? (
              <IconButton
                size="small"
                onClick={() => {
                  setQuery('');
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
            open={open && items.length > 0}
            anchorEl={containerRef.current}
            placement="bottom-start"
            modifiers={[{ name: 'offset', options: { offset: [0, 6] } }]}
            sx={{ zIndex: (theme) => theme.zIndex.modal }}
          >
            <Paper
              sx={{
                width: containerRef.current?.clientWidth ?? 'auto',
                py: 0.5,
                maxHeight: 360,
                overflowY: 'auto',
                border: '1px solid var(--mui-palette-divider)',
              }}
            >
              {items.map((item, idx) => {
                const selected = idx === highlight;
                const Icon = item.kind === 'recent' ? HistoryIcon : NorthEastIcon;
                return (
                  <ListItemButton
                    key={`${item.kind}:${item.value}`}
                    selected={selected}
                    onMouseEnter={() => setHighlight(idx)}
                    onClick={() => submit(item.value)}
                    sx={{
                      mx: 0.5,
                      py: 0.5,
                      px: 1,
                      borderRadius: 1.5,
                      gap: 1,
                      '&.Mui-selected': {
                        backgroundColor: 'var(--mui-palette-action-hover)',
                      },
                    }}
                  >
                    <Icon
                      sx={{
                        fontSize: 16,
                        color:
                          item.kind === 'recent'
                            ? 'text.secondary'
                            : 'var(--mui-palette-primary-main)',
                      }}
                    />
                    <Typography
                      sx={{
                        flex: 1,
                        fontSize: 13.5,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.value}
                    </Typography>
                    {item.kind === 'recent' && (
                      <Tooltip title={t('search.removeRecent')}>
                        <IconButton
                          size="small"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeRecent(item.value);
                          }}
                          sx={{ p: 0.25 }}
                        >
                          <CloseIcon sx={{ fontSize: 14 }} />
                        </IconButton>
                      </Tooltip>
                    )}
                  </ListItemButton>
                );
              })}
              <Stack
                direction="row"
                alignItems="center"
                justifyContent="space-between"
                sx={{
                  px: 1.5,
                  pt: 0.75,
                  mt: 0.25,
                  borderTop: '1px solid var(--mui-palette-divider)',
                  color: 'text.secondary',
                  fontSize: 11,
                }}
              >
                <Box>
                  <Box component="span" sx={{ fontWeight: 500, color: 'text.primary' }}>
                    ↵
                  </Box>{' '}
                  {t('search.toSearch')}{' '}
                  <Box component="span" sx={{ fontWeight: 500, color: 'text.primary' }}>
                    {isMac ? '⌘' : 'Ctrl'}+↵
                  </Box>{' '}
                  {t('search.newTab')}
                </Box>
                <Box>
                  {t('search.via')}{' '}
                  <Box
                    component="span"
                    sx={{ fontWeight: 500, color: 'text.primary' }}
                  >
                    {engine === 'google' ? 'Google' : 'Bing'}
                  </Box>
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
