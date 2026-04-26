import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  Typography,
} from '@mui/material';
import LockPersonIcon from '@mui/icons-material/LockPerson';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import HistoryToggleOffIcon from '@mui/icons-material/HistoryToggleOff';
import CleaningServicesIcon from '@mui/icons-material/CleaningServices';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import { useDataSummary } from '../hooks/useDataSummary';

const STORAGE_KEY = 'augur:onboarded';

function PromiseRow({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <Stack direction="row" spacing={2} alignItems="flex-start">
      <Box
        sx={{
          width: 40,
          height: 40,
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
      <Box>
        <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
          {title}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {body}
        </Typography>
      </Box>
    </Stack>
  );
}

export function Onboarding() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { summary } = useDataSummary();

  useEffect(() => {
    try {
      const seen = localStorage.getItem(STORAGE_KEY);
      if (!seen) setOpen(true);
    } catch {
      // localStorage may be blocked in some contexts; default to skip onboarding.
    }
  }, []);

  const close = () => {
    try {
      localStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch {
      // ignore
    }
    setOpen(false);
  };

  const events = summary?.eventCount ?? 0;
  const target = 50;
  const progress = Math.min(100, (events / target) * 100);

  return (
    <Dialog
      open={open}
      onClose={close}
      maxWidth="sm"
      fullWidth
      slotProps={{ paper: { sx: { borderRadius: 4, p: 1 } } }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Box
          aria-hidden
          sx={{
            width: 36,
            height: 36,
            borderRadius: '50%',
            background:
              'conic-gradient(from 200deg, var(--mui-palette-primary-main), var(--mui-palette-secondary-main), var(--mui-palette-primary-main))',
          }}
        />
        <Box>
          <Typography variant="h6" sx={{ lineHeight: 1.2 }}>
            {t('onboarding.title')}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t('onboarding.subtitle')}
          </Typography>
        </Box>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <PromiseRow
            icon={<LockPersonIcon />}
            title={t('onboarding.privacy.title')}
            body={t('onboarding.privacy.body')}
          />
          <PromiseRow
            icon={<HistoryToggleOffIcon />}
            title={t('onboarding.collect.title')}
            body={t('onboarding.collect.body')}
          />
          <PromiseRow
            icon={<AutoAwesomeIcon />}
            title={t('onboarding.suggestRow.title')}
            body={t('onboarding.suggestRow.body')}
          />
          <PromiseRow
            icon={<CleaningServicesIcon />}
            title={t('onboarding.cleanupRow.title')}
            body={t('onboarding.cleanupRow.body')}
          />
          <PromiseRow
            icon={<KeyboardIcon />}
            title={t('onboarding.shortcutRow.title')}
            body={t('onboarding.shortcutRow.body')}
          />
          <Box sx={{ pt: 1 }}>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                mb: 0.5,
              }}
            >
              <Typography variant="body2" sx={{ fontWeight: 500 }}>
                {t('onboarding.progressTitle')}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {t('onboarding.progressCount', { events, target })}
              </Typography>
            </Box>
            <LinearProgress
              variant="determinate"
              value={progress}
              sx={{ borderRadius: 999, height: 8 }}
            />
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
              {events < target
                ? t('onboarding.progressHint')
                : t('onboarding.progressReady')}
            </Typography>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={close} variant="contained" size="large">
          {t('onboarding.cta')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
