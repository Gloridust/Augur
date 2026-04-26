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
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import DeleteIcon from '@mui/icons-material/Delete';
import RefreshIcon from '@mui/icons-material/Refresh';
import InventoryIcon from '@mui/icons-material/Inventory2';
import type { StashedTab } from '../../shared/types';
import {
  deleteStashedItems,
  listStashedItems,
  unstashItem,
} from '../api/recommendations';

function favicon(s: StashedTab): string | undefined {
  if (s.favIconUrl) return s.favIconUrl;
  try {
    return `https://www.google.com/s2/favicons?sz=64&domain=${new URL(s.url).hostname}`;
  } catch {
    return undefined;
  }
}

function relativeTime(ts: number, locale: string): string {
  const ms = Date.now() - ts;
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const min = ms / 60_000;
  if (min < 1) return fmt.format(0, 'minute');
  if (min < 60) return fmt.format(-Math.round(min), 'minute');
  const hr = min / 60;
  if (hr < 24) return fmt.format(-Math.round(hr), 'hour');
  return fmt.format(-Math.round(hr / 24), 'day');
}

export function StashSection() {
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<StashedTab[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setItems(await listStashedItems());
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const handler = () => refresh();
    window.addEventListener('chromehomepage:stash-changed', handler);
    return () => window.removeEventListener('chromehomepage:stash-changed', handler);
  }, [refresh]);

  // Hide entirely when stash is empty — keeps the dashboard tidy.
  if (items.length === 0) return null;

  const onOpen = async (item: StashedTab) => {
    if (item.id === undefined) return;
    await unstashItem(item.id);
    setItems((prev) => prev.filter((p) => p.id !== item.id));
  };

  const onDelete = async (item: StashedTab) => {
    if (item.id === undefined) return;
    await deleteStashedItems([item.id]);
    setItems((prev) => prev.filter((p) => p.id !== item.id));
  };

  const onOpenAll = async () => {
    setBusy(true);
    try {
      for (const item of items) {
        if (item.id === undefined) continue;
        await unstashItem(item.id);
      }
      setItems([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 2, gap: 1, flexWrap: 'wrap' }}>
        <InventoryIcon sx={{ color: 'text.secondary' }} />
        <Typography variant="h5">{t('sections.stash')}</Typography>
        <Chip label={items.length} size="small" />
        <Box sx={{ flex: 1 }} />
        <Button onClick={onOpenAll} variant="outlined" disabled={busy}>
          {t('stash.openAll')}
        </Button>
        <Tooltip title={t('actions.refresh')}>
          <IconButton onClick={refresh} size="small">
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gap: 1.5,
          gridTemplateColumns: {
            xs: '1fr',
            sm: 'repeat(2, 1fr)',
            md: 'repeat(3, 1fr)',
          },
        }}
      >
        {items.map((item) => (
          <Card
            key={item.id}
            sx={{
              p: 1.5,
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              backgroundColor: 'rgba(98, 91, 113, 0.04)',
            }}
          >
            <Avatar
              src={favicon(item)}
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
                title={item.title}
              >
                {item.title}
              </Typography>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.25 }}>
                <Typography variant="caption" color="text.secondary">
                  {item.domain}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  · {relativeTime(item.stashedAt, i18n.language)}
                </Typography>
                {item.source === 'cleanup' && (
                  <Chip
                    label={t('stash.fromCleanup')}
                    size="small"
                    sx={{ height: 18, fontSize: 10 }}
                  />
                )}
              </Stack>
            </Box>
            <Tooltip title={t('stash.delete')}>
              <IconButton size="small" onClick={() => onDelete(item)}>
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title={t('stash.open')}>
              <IconButton size="small" onClick={() => onOpen(item)} color="primary">
                <OpenInNewIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Card>
        ))}
      </Box>
    </Box>
  );
}

// Dispatch on stash mutations so the section stays in sync without polling.
export function notifyStashChanged(): void {
  window.dispatchEvent(new Event('chromehomepage:stash-changed'));
}
