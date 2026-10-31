import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box } from '@mui/material';
import type { TodayRecap as TodayRecapData } from '../../shared/types';
import { fetchTodayRecap } from '../api/recommendations';
import { visiblePoll } from '../liveRefresh';

// One quiet line of today's numbers. It used to be five icon-in-a-circle
// stat tiles — the hero-metric template, louder than anything else on a
// page whose job is getting you to the next tab.
function Stat({ value, label, hint }: { value: string | number; label: string; hint?: string }) {
  return (
    <Box component="span" title={hint} sx={{ whiteSpace: 'nowrap' }}>
      <Box component="span" className="augur-num" sx={{ fontWeight: 600, color: 'text.primary', mr: 0.5 }}>
        {value}
      </Box>
      {label}
    </Box>
  );
}

export function TodayRecap() {
  const { t } = useTranslation();
  const [data, setData] = useState<TodayRecapData | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void fetchTodayRecap().then((d) => {
        if (!cancelled) setData(d);
      });
    load();
    const stop = visiblePoll(load, 60_000);
    return () => {
      cancelled = true;
      stop();
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
    <Box
      component="p"
      aria-label={t('today.title')}
      sx={{
        m: 0,
        px: 0.5,
        display: 'flex',
        flexWrap: 'wrap',
        columnGap: 2.5,
        rowGap: 0.5,
        justifyContent: { xs: 'flex-start', md: 'flex-end' },
        fontSize: 13.5,
        color: 'text.secondary',
      }}
    >
      <Stat value={data.tabsOpened} label={t('today.tabsOpened')} />
      <Stat value={data.domainsVisited} label={t('today.domainsVisited')} />
      <Stat value={`${data.focusMinutes}m`} label={t('today.focusMinutes')} />
      {data.topDomain && <Stat value={top.value} label={t('today.topDomain')} hint={top.hint} />}
      {data.busiestHour && <Stat value={busy} label={t('today.busiestHour')} />}
    </Box>
  );
}
