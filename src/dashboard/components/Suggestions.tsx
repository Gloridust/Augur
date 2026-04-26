import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  Box,
  Card,
  Chip,
  IconButton,
  Skeleton,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import PushPinIcon from '@mui/icons-material/PushPin';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import type { OpenCandidate } from '../../shared/types';
import {
  fetchOpenRecommendations,
  openUrlViaSw,
  reportOpenFeedback,
} from '../api/recommendations';
import { useDataSummary } from '../hooks/useDataSummary';
import { usePins } from '../hooks/usePins';
import { LearningEmptyState } from './LearningEmptyState';

function favicon(url: string): string {
  try {
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?sz=64&domain=${u.hostname}`;
  } catch {
    return '';
  }
}

function confidenceTier(score: number): 'low' | 'medium' | 'high' {
  if (score >= 0.55) return 'high';
  if (score >= 0.3) return 'medium';
  return 'low';
}

interface Props {
  dense?: boolean;
}

export function Suggestions({ dense = false }: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<OpenCandidate[] | null>(null);
  const [loading, setLoading] = useState(true);
  const { summary } = useDataSummary();
  const { isPinned, add: pinAdd, remove: pinRemove } = usePins();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchOpenRecommendations();
      setItems(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Refresh when the active tab changes — recommendations key off the
    // currently focused domain (co-occurrence, embedding similarity), so a
    // stale list right after the user switches contexts is misleading.
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
    chrome.tabs.onUpdated.addListener(trigger);
    return () => {
      chrome.tabs.onActivated.removeListener(trigger);
      chrome.tabs.onUpdated.removeListener(trigger);
    };
  }, [refresh]);

  const onOpen = async (c: OpenCandidate) => {
    await reportOpenFeedback(c.domain, c.features, 'accepted');
    await openUrlViaSw(c.url);
    setItems((prev) => (prev ? prev.filter((p) => p.domain !== c.domain) : prev));
  };

  const onDismiss = async (c: OpenCandidate) => {
    await reportOpenFeedback(c.domain, c.features, 'dismissed');
    setItems((prev) => (prev ? prev.filter((p) => p.domain !== c.domain) : prev));
  };

  // Dense mode: 2-col grid since the section sits in a 50% column on lg+.
  // Roomy mode: full-width row across the dashboard.
  const gridCols = dense
    ? { xs: '1fr', sm: 'repeat(2, 1fr)' }
    : {
        xs: '1fr',
        sm: 'repeat(2, 1fr)',
        md: 'repeat(3, 1fr)',
        lg: 'repeat(4, 1fr)',
        xl: 'repeat(5, 1fr)',
      };
  const cardPadding = dense ? 1.5 : 2;
  const cardMinHeight = dense ? 110 : 132;

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1.5, gap: 1 }}>
        <Typography variant="h6" sx={{ fontWeight: 500 }}>
          {t('sections.suggestions')}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip title={t('actions.refresh')}>
          <IconButton onClick={refresh} size="small" sx={{ p: 0.5 }}>
            <RefreshIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      </Box>
      <Box
        sx={{
          display: 'grid',
          gap: dense ? 1.5 : 2,
          gridTemplateColumns: gridCols,
        }}
      >
        {loading && items === null
          ? Array.from({ length: dense ? 4 : 5 }, (_, i) => (
              <Skeleton
                key={i}
                variant="rounded"
                height={cardMinHeight}
                sx={{ borderRadius: 2 }}
              />
            ))
          : items && items.length > 0
            ? items.map((c) => (
                <Card
                  key={c.domain}
                  sx={{
                    p: cardPadding,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: dense ? 0.75 : 1.25,
                    minHeight: cardMinHeight,
                    cursor: 'pointer',
                    transition:
                      'transform 200ms cubic-bezier(0.2, 0, 0, 1), background-color 200ms cubic-bezier(0.2, 0, 0, 1)',
                    '&:hover': {
                      transform: 'translateY(-2px)',
                      backgroundColor: 'var(--mui-palette-action-hover)',
                    },
                  }}
                  onClick={() => onOpen(c)}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Avatar
                      src={favicon(c.url)}
                      variant="rounded"
                      sx={{
                        width: dense ? 22 : 28,
                        height: dense ? 22 : 28,
                        bgcolor: 'transparent',
                      }}
                    />
                    <Typography
                      sx={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: dense ? 13 : 14,
                        fontWeight: 500,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.title || c.domain}
                    </Typography>
                    <Tooltip title={isPinned(c.url) ? t('pins.unpin') : t('pins.pin')}>
                      <IconButton
                        size="small"
                        sx={{
                          p: 0.25,
                          color: isPinned(c.url) ? 'primary.main' : 'inherit',
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isPinned(c.url)) {
                            void pinRemove(c.url);
                          } else {
                            void pinAdd({ url: c.url, title: c.title || c.domain });
                          }
                        }}
                      >
                        {isPinned(c.url) ? (
                          <PushPinIcon sx={{ fontSize: 16 }} />
                        ) : (
                          <PushPinOutlinedIcon sx={{ fontSize: 16 }} />
                        )}
                      </IconButton>
                    </Tooltip>
                    <Tooltip title={t('actions.dismiss')}>
                      <IconButton
                        size="small"
                        sx={{ p: 0.25 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          void onDismiss(c);
                        }}
                      >
                        <CloseIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    </Tooltip>
                  </Box>
                  <Typography
                    sx={{
                      fontSize: dense ? 11 : 12,
                      color: 'text.secondary',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {c.domain}
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 'auto' }}>
                    <Chip
                      size="small"
                      sx={{ height: dense ? 20 : 24, fontSize: dense ? 10 : 12 }}
                      label={t(`reasons.${c.reason}`, { defaultValue: c.reason })}
                    />
                    <Chip
                      size="small"
                      sx={{ height: dense ? 20 : 24, fontSize: dense ? 10 : 12 }}
                      label={t(`confidence.${confidenceTier(c.score)}`)}
                      color={confidenceTier(c.score) === 'high' ? 'primary' : 'default'}
                      variant={confidenceTier(c.score) === 'high' ? 'filled' : 'outlined'}
                    />
                  </Box>
                </Card>
              ))
            : (
                <LearningEmptyState
                  summary={summary}
                  ready={summary?.recommendationsReady ?? false}
                  readyMessage={t('suggestions.readyEmpty')}
                  warmupMessage={t('suggestions.warmup')}
                  icon={<AutoAwesomeIcon />}
                />
              )}
      </Box>
    </Box>
  );
}
