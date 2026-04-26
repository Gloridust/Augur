import { useTranslation } from 'react-i18next';
import { Box, Typography } from '@mui/material';
import { MagicBall } from './MagicBall';
import { useUserName } from '../hooks/useUserName';

function timeBucket(hour: number): 'morning' | 'afternoon' | 'evening' | 'night' {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 23) return 'evening';
  return 'night';
}

export function Greeting() {
  const { t, i18n } = useTranslation();
  const name = useUserName();
  const now = new Date();
  const bucket = timeBucket(now.getHours());
  const dateFmt = new Intl.DateTimeFormat(i18n.language, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  const greeting = name
    ? t(`greeting.${bucket}WithName`, {
        name,
        defaultValue: `${t(`greeting.${bucket}`)}, ${name}`,
      })
    : t(`greeting.${bucket}`);
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: { xs: 2, md: 2.5 } }}>
      <Box
        sx={{
          color: 'var(--mui-palette-primary-main)',
          flexShrink: 0,
          mt: { xs: 0.5, md: 1 },
        }}
      >
        <MagicBall size={56} />
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography
          component="h1"
          variant="h2"
          sx={{
            fontSize: { xs: '1.875rem', md: '2.25rem' },
            lineHeight: 1.05,
          }}
        >
          {greeting}
        </Typography>
        <Typography
          sx={{
            fontSize: 13,
            color: 'text.secondary',
            mt: 0.75,
          }}
        >
          {dateFmt.format(now)}
        </Typography>
      </Box>
    </Box>
  );
}
