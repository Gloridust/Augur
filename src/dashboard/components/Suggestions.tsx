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
import type { OpenCandidate } from '../../shared/types';
import {
  fetchOpenRecommendations,
  openUrlViaSw,
  reportOpenFeedback,
} from '../api/recommendations';
import { useDataSummary } from '../hooks/useDataSummary';
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

export function Suggestions() {
  const { t } = useTranslation();
  const [items, setItems] = useState<OpenCandidate[] | null>(null);
  const [loading, setLoading] = useState(true);
  const { summary } = useDataSummary();

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

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 2, gap: 1 }}>
        <Typography variant="h5">{t('sections.suggestions')}</Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip title={t('actions.refresh')}>
          <IconButton onClick={refresh} size="small">
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: {
            xs: '1fr',
            sm: 'repeat(2, 1fr)',
            md: 'repeat(3, 1fr)',
            lg: 'repeat(5, 1fr)',
          },
        }}
      >
        {loading && items === null
          ? Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} variant="rounded" height={120} sx={{ borderRadius: 4 }} />
            ))
          : items && items.length > 0
            ? items.map((c) => (
                <Card
                  key={c.domain}
                  sx={{
                    p: 2,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 1.5,
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
                      sx={{ width: 28, height: 28, bgcolor: 'transparent' }}
                    />
                    <Typography
                      variant="subtitle2"
                      sx={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.title || c.domain}
                    </Typography>
                    <Tooltip title={t('actions.dismiss')}>
                      <IconButton
                        size="small"
                        onClick={(e) => {
                          e.stopPropagation();
                          void onDismiss(c);
                        }}
                      >
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Box>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {c.domain}
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                    <Chip
                      size="small"
                      label={t(`reasons.${c.reason}`, { defaultValue: c.reason })}
                    />
                    <Chip
                      size="small"
                      label={t(`confidence.${confidenceTier(c.score)}`)}
                      color={
                        confidenceTier(c.score) === 'high'
                          ? 'primary'
                          : confidenceTier(c.score) === 'medium'
                            ? 'default'
                            : 'default'
                      }
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
