import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Card, Stack, Typography } from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import LanguageIcon from '@mui/icons-material/Language';
import HourglassTopIcon from '@mui/icons-material/HourglassTop';
import StarIcon from '@mui/icons-material/Star';
import type { TodayRecap as TodayRecapData } from '../../shared/types';
import { fetchTodayRecap } from '../api/recommendations';

interface StatProps {
  icon: React.ReactNode;
  value: string | number;
  label: string;
  hint?: string;
}

function Stat({ icon, value, label, hint }: StatProps) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
      <Box
        aria-hidden
        sx={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          flexShrink: 0,
          display: 'grid',
          placeItems: 'center',
          backgroundColor: 'var(--mui-palette-primary-light)',
          color: 'var(--mui-palette-primary-dark)',
        }}
      >
        {icon}
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="h6" sx={{ fontWeight: 500, lineHeight: 1.1 }}>
          {value}
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
          title={hint}
        >
          {label}
        </Typography>
      </Box>
    </Box>
  );
}

export function TodayRecap() {
  const { t } = useTranslation();
  const [data, setData] = useState<TodayRecapData | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchTodayRecap().then((d) => {
      if (!cancelled) setData(d);
    });
    const handle = window.setInterval(async () => {
      const d = await fetchTodayRecap();
      if (!cancelled) setData(d);
    }, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, []);

  // Hide entirely until there's anything for today.
  if (!data || (data.tabsOpened === 0 && data.focusMinutes === 0)) return null;

  const top = data.topDomain
    ? {
        value: data.topDomain.domain,
        hint: t('today.topDomainHint', {
          minutes: Math.round(data.topDomain.focusMs / 60_000),
        }),
      }
    : { value: '—', hint: undefined };

  const busy = data.busiestHour
    ? `${data.busiestHour.hour.toString().padStart(2, '0')}:00`
    : '—';

  return (
    <Card
      sx={{
        p: 2,
        backgroundColor: 'var(--mui-palette-action-hover)',
        border: '1px solid var(--mui-palette-divider)',
      }}
    >
      <Stack
        direction="row"
        spacing={3}
        useFlexGap
        flexWrap="wrap"
        divider={
          <Box
            sx={{
              width: '1px',
              alignSelf: 'stretch',
              backgroundColor: 'var(--mui-palette-divider)',
            }}
          />
        }
      >
        <Stat
          icon={<OpenInNewIcon fontSize="small" />}
          value={data.tabsOpened}
          label={t('today.tabsOpened')}
        />
        <Stat
          icon={<LanguageIcon fontSize="small" />}
          value={data.domainsVisited}
          label={t('today.domainsVisited')}
        />
        <Stat
          icon={<HourglassTopIcon fontSize="small" />}
          value={`${data.focusMinutes}m`}
          label={t('today.focusMinutes')}
        />
        <Stat
          icon={<StarIcon fontSize="small" />}
          value={top.value}
          label={t('today.topDomain')}
          hint={top.hint}
        />
        <Stat
          icon={<HourglassTopIcon fontSize="small" />}
          value={busy}
          label={t('today.busiestHour')}
        />
      </Stack>
    </Card>
  );
}
