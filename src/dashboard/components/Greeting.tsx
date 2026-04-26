import { useTranslation } from 'react-i18next';
import { Box, Typography } from '@mui/material';
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
    <Box>
      <Typography
        component="h1"
        sx={{
          fontWeight: 500,
          fontSize: { xs: '1.75rem', md: '2rem' },
          lineHeight: 1.1,
          letterSpacing: '-0.01em',
        }}
      >
        {greeting}
      </Typography>
      <Typography
        sx={{
          fontSize: 13,
          color: 'text.secondary',
          mt: 0.5,
        }}
      >
        {dateFmt.format(now)}
      </Typography>
    </Box>
  );
}
