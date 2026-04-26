import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Card,
  Skeleton,
  Stack,
  Typography,
  useTheme,
} from '@mui/material';
import type { InsightsBundle } from '../../ml/insights';
import { fetchInsights } from '../api/recommendations';

function colorScale(value: number, max: number, base: string): string {
  if (max <= 0) return 'transparent';
  const t = Math.min(1, value / max);
  const alpha = 0.05 + 0.85 * t;
  return base.replace('ALPHA', String(alpha.toFixed(3)));
}

export function Insights() {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const [data, setData] = useState<InsightsBundle | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchInsights().then((d) => {
      if (!cancelled) setData(d);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const dayLabels = useMemo(() => {
    const ref = new Date(2024, 0, 7); // a Sunday
    const fmt = new Intl.DateTimeFormat(i18n.language, { weekday: 'short' });
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(ref);
      d.setDate(ref.getDate() + i);
      return fmt.format(d);
    });
  }, [i18n.language]);

  if (!data) {
    return (
      <Box>
        <Typography variant="h5" sx={{ mb: 2 }}>
          {t('sections.insights')}
        </Typography>
        <Skeleton variant="rounded" height={220} sx={{ borderRadius: 4 }} />
      </Box>
    );
  }

  const max = Math.max(0, ...data.heatmap.matrix.flat());
  // Coral with variable alpha — matches the paper-theme primary (#C2410C)
  // so the heatmap reads as a single design language with the rest of the UI.
  const baseColor = `rgba(194, 65, 12, ALPHA)`;

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, mb: 2, flexWrap: 'wrap' }}>
        <Typography variant="h5">{t('sections.insights')}</Typography>
        <Typography variant="body2" color="text.secondary">
          {t('insights.totalFocus', { hours: (data.totals.focusMinutesLast30d / 60).toFixed(1) })}
          {' · '}
          {t('insights.distinctDomains', { count: data.totals.distinctDomains })}
        </Typography>
      </Box>

      <Stack spacing={3}>
        <Card sx={{ p: 3 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 500, mb: 2 }}>
            {t('insights.heatmapTitle')}
          </Typography>
          <Box sx={{ overflowX: 'auto' }}>
            <Box
              role="figure"
              sx={{
                display: 'grid',
                gridTemplateColumns: 'auto repeat(24, minmax(18px, 1fr))',
                gap: 0.5,
                minWidth: 720,
              }}
            >
              <Box />
              {Array.from({ length: 24 }, (_, h) => (
                <Typography
                  key={h}
                  variant="caption"
                  sx={{ textAlign: 'center', color: 'text.secondary' }}
                >
                  {h % 3 === 0 ? h : ''}
                </Typography>
              ))}
              {dayLabels.map((label, dow) => (
                <>
                  <Typography
                    key={`l-${dow}`}
                    variant="caption"
                    sx={{ pr: 1, alignSelf: 'center', color: 'text.secondary' }}
                  >
                    {label}
                  </Typography>
                  {data.heatmap.matrix[dow].map((v, h) => (
                    <Box
                      key={`${dow}-${h}`}
                      title={`${label} ${h}:00 — ${Math.round(v)} min`}
                      sx={{
                        height: 18,
                        borderRadius: 0.75,
                        backgroundColor: colorScale(v, max, baseColor),
                        border: '1px solid',
                        borderColor: theme.palette.divider,
                      }}
                    />
                  ))}
                </>
              ))}
            </Box>
          </Box>
        </Card>

        <Card sx={{ p: 3 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 500, mb: 2 }}>
            {t('insights.topDomainsTitle')}
          </Typography>
          {data.topDomains.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              {t('insights.empty')}
            </Typography>
          ) : (
            <Stack spacing={1}>
              {data.topDomains.map((row) => {
                const widthPct =
                  data.topDomains[0].totalMs > 0
                    ? (row.totalMs / data.topDomains[0].totalMs) * 100
                    : 0;
                return (
                  <Box key={row.domain} sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <Typography
                      variant="body2"
                      sx={{
                        width: 220,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {row.domain}
                    </Typography>
                    <Box
                      sx={{
                        flex: 1,
                        height: 8,
                        borderRadius: 999,
                        backgroundColor: 'var(--mui-palette-action-hover)',
                        overflow: 'hidden',
                      }}
                    >
                      <Box
                        sx={{
                          width: `${widthPct}%`,
                          height: '100%',
                          background:
                            'linear-gradient(90deg, var(--mui-palette-primary-dark), var(--mui-palette-primary-main))',
                          transition: 'width 400ms cubic-bezier(0.2, 0, 0, 1)',
                        }}
                      />
                    </Box>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ width: 64, textAlign: 'right' }}
                    >
                      {(row.totalMs / 60_000).toFixed(0)} min
                    </Typography>
                  </Box>
                );
              })}
            </Stack>
          )}
        </Card>
      </Stack>
    </Box>
  );
}
