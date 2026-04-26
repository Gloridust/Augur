import { Box, Card, LinearProgress, Stack, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { DataSummary } from '../../shared/types';

interface Props {
  summary: DataSummary | null;
  ready: boolean;
  warmupTarget?: number;
  readyMessage: string;
  warmupMessage: string;
  icon?: React.ReactNode;
}

export function LearningEmptyState({
  summary,
  ready,
  warmupTarget = 50,
  readyMessage,
  warmupMessage,
  icon,
}: Props) {
  const { t } = useTranslation();
  const events = summary?.eventCount ?? 0;
  const progress = Math.min(100, (events / warmupTarget) * 100);

  return (
    <Card
      sx={{
        p: 4,
        gridColumn: '1 / -1',
        borderStyle: ready ? 'solid' : 'dashed',
        backgroundColor: ready
          ? 'var(--mui-palette-background-paper)'
          : 'var(--mui-palette-action-hover)',
      }}
    >
      <Stack spacing={2} alignItems="center" sx={{ textAlign: 'center' }}>
        {icon && (
          <Box
            sx={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              backgroundColor: 'var(--mui-palette-primary-light)',
              color: 'var(--mui-palette-primary-dark)',
            }}
          >
            {icon}
          </Box>
        )}
        <Typography variant="body1" sx={{ maxWidth: 480, fontWeight: 500 }}>
          {ready ? readyMessage : warmupMessage}
        </Typography>
        {!ready && (
          <Box sx={{ width: '100%', maxWidth: 320 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                {t('learning.progress')}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {t('learning.count', { current: events, target: warmupTarget })}
              </Typography>
            </Box>
            <LinearProgress
              variant="determinate"
              value={progress}
              sx={{ borderRadius: 999, height: 6 }}
            />
          </Box>
        )}
      </Stack>
    </Card>
  );
}
