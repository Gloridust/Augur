import { useTranslation } from 'react-i18next';
import { Box, Typography } from '@mui/material';

function timeBucket(hour: number): 'morning' | 'afternoon' | 'evening' | 'night' {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 23) return 'evening';
  return 'night';
}

export function Greeting() {
  const { t, i18n } = useTranslation();
  const now = new Date();
  const bucket = timeBucket(now.getHours());
  const dateFmt = new Intl.DateTimeFormat(i18n.language, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  return (
    <Box>
      <Typography variant="h2" component="h1" sx={{ fontWeight: 400 }}>
        {t(`greeting.${bucket}`)}
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mt: 0.5 }}>
        {dateFmt.format(now)}
      </Typography>
    </Box>
  );
}
