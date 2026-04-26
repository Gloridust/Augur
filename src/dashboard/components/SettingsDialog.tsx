import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Select,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '../i18n';
import { exportAllData, wipeAllData } from '../api/recommendations';
import { useDataSummary } from '../hooks/useDataSummary';
import { useUserNameField } from '../hooks/useUserName';
import { useSmartPinSort } from '../hooks/useSmartPinSort';
import { ModelDebugPanel } from './ModelDebugPanel';
import { SetAsHomepageGuide } from './SetAsHomepageGuide';

interface Props {
  open: boolean;
  onClose: () => void;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {label}
      </Typography>
      <Typography variant="h6" sx={{ fontWeight: 500, lineHeight: 1.2 }}>
        {value}
      </Typography>
    </Box>
  );
}

export function SettingsDialog({ open, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const [userName, setStoredUserName] = useUserNameField();
  const [userNameDraft, setUserNameDraft] = useState(userName);
  const [smartPinSort, setSmartPinSort] = useSmartPinSort();

  // Re-seed the draft when the dialog opens so it stays consistent with the
  // current saved value (e.g. after a wipe-all that resets the name too).
  // We don't need useEffect here — the draft state syncs on each open.
  const { summary, refresh } = useDataSummary();
  const [confirmingWipe, setConfirmingWipe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'general' | 'data' | 'advanced'>('general');

  const onExport = async () => {
    setBusy(true);
    try {
      const dump = await exportAllData();
      if (!dump) return;
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `chromehomepage-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };

  const onWipe = async () => {
    setBusy(true);
    try {
      await wipeAllData();
      setConfirmingWipe(false);
      await refresh();
      try {
        localStorage.removeItem('augur:onboarded');
      } catch {
        // ignore
      }
      onClose();
      // Reload so the dashboard re-fetches with fresh state.
      window.location.reload();
    } finally {
      setBusy(false);
    }
  };

  const formatDate = (ts: number | null) =>
    ts === null
      ? t('settings.never')
      : new Intl.DateTimeFormat(i18n.language, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(ts));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      slotProps={{ paper: { sx: { borderRadius: 4 } } }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', pb: 0 }}>
        <Typography variant="h6" sx={{ flex: 1 }}>
          {t('actions.settings')}
        </Typography>
        <IconButton onClick={onClose} size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <Box sx={{ px: 3, pt: 1, borderBottom: '1px solid var(--mui-palette-divider)' }}>
        <Tabs
          value={tab}
          onChange={(_, v) => setTab(v as typeof tab)}
          variant="standard"
          sx={{
            minHeight: 40,
            '& .MuiTab-root': { minHeight: 40, textTransform: 'none', fontWeight: 500 },
          }}
        >
          <Tab value="general" label={t('settings.tabGeneral')} />
          <Tab value="data" label={t('settings.tabData')} />
          <Tab value="advanced" label={t('settings.tabAdvanced')} />
        </Tabs>
      </Box>
      <DialogContent>
        {tab === 'general' && (
          <Stack spacing={3} divider={<Divider flexItem />}>
            <Stack spacing={1.5}>
              <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
                {t('settings.profile')}
              </Typography>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 2,
                }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2">{t('settings.userName')}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t('settings.userNameHint')}
                  </Typography>
                </Box>
                <TextField
                  size="small"
                  value={userNameDraft}
                  placeholder={t('settings.userNamePlaceholder')}
                  onChange={(e) => setUserNameDraft(e.target.value)}
                  onBlur={() => {
                    if (userNameDraft !== userName) setStoredUserName(userNameDraft);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      setStoredUserName(userNameDraft);
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  inputProps={{ maxLength: 40 }}
                  sx={{ width: 200 }}
                />
              </Box>
            </Stack>
            <Stack spacing={1.5}>
              <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
                {t('homepage.title')}
              </Typography>
              <SetAsHomepageGuide />
            </Stack>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
                {t('actions.language')}
              </Typography>
              <Select
                size="small"
                value={i18n.resolvedLanguage ?? 'en'}
                onChange={(e) =>
                  void i18n.changeLanguage(e.target.value as SupportedLanguage)
                }
                sx={{ minWidth: 160 }}
              >
                {SUPPORTED_LANGUAGES.map((lng) => (
                  <MenuItem key={lng} value={lng}>
                    {t(`languages.${lng}`)}
                  </MenuItem>
                ))}
              </Select>
            </Box>
            <Stack spacing={1.5}>
              <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
                {t('settings.pinsTitle')}
              </Typography>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 2,
                }}
              >
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography variant="body2">
                    {t('settings.smartPinSort')}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t('settings.smartPinSortHint')}
                  </Typography>
                </Box>
                <Switch
                  checked={smartPinSort}
                  onChange={(_, v) => setSmartPinSort(v)}
                />
              </Box>
            </Stack>
          </Stack>
        )}

        {tab === 'data' && (
          <Stack spacing={3}>
            <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
              {t('settings.dataTitle')}
            </Typography>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: 2,
                p: 2,
                borderRadius: 3,
                backgroundColor: 'var(--mui-palette-action-hover)',
              }}
            >
              <Stat label={t('settings.events')} value={summary?.eventCount ?? '—'} />
              <Stat label={t('settings.domains')} value={summary?.domainCount ?? '—'} />
              <Stat label={t('settings.feedback')} value={summary?.feedbackCount ?? '—'} />
              <Stat
                label={t('settings.firstEvent')}
                value={formatDate(summary?.firstEventAt ?? null)}
              />
              <Stat
                label={t('settings.cleanupTraining')}
                value={`${summary?.cleanupTrainedSamples ?? 0} / ${summary?.cleanupPositiveSamples ?? 0}`}
              />
              <Stat
                label={t('settings.recommendTraining')}
                value={`${summary?.recommendTrainedSamples ?? 0} / ${summary?.recommendPositiveSamples ?? 0}`}
              />
            </Box>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Tooltip title={t('settings.exportTooltip')}>
                <span>
                  <Button
                    onClick={onExport}
                    startIcon={<DownloadIcon />}
                    disabled={busy}
                    variant="outlined"
                  >
                    {t('settings.export')}
                  </Button>
                </span>
              </Tooltip>
              {confirmingWipe ? (
                <>
                  <Button
                    onClick={onWipe}
                    startIcon={<DeleteForeverIcon />}
                    disabled={busy}
                    variant="contained"
                    color="error"
                  >
                    {t('settings.wipeConfirm')}
                  </Button>
                  <Button onClick={() => setConfirmingWipe(false)} disabled={busy}>
                    {t('settings.cancel')}
                  </Button>
                </>
              ) : (
                <Button
                  onClick={() => setConfirmingWipe(true)}
                  startIcon={<RestartAltIcon />}
                  variant="text"
                  color="error"
                  disabled={busy}
                >
                  {t('settings.wipe')}
                </Button>
              )}
            </Stack>
            <Typography variant="caption" color="text.secondary">
              {t('settings.privacyHint')}
            </Typography>
          </Stack>
        )}

        {tab === 'advanced' && <ModelDebugPanel />}
      </DialogContent>
    </Dialog>
  );
}
