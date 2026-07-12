import { useRef, useState } from 'react';
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
import HistoryIcon from '@mui/icons-material/History';
import BugReportIcon from '@mui/icons-material/BugReport';
import UploadIcon from '@mui/icons-material/Upload';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '../i18n';
import {
  exportAllData,
  exportDebugBundle,
  importAllData,
  rebuildAggregates,
  rebuildSequenceMemory,
  replayImplicitTraining,
  retrainEmbedding,
  retrainForest,
  seedFromBrowserHistory,
  wipeAllData,
} from '../api/recommendations';
import { debugBundleToDump, isZipFile } from '../zipReader';
import { toast } from './Toaster';
import { useDataSummary } from '../hooks/useDataSummary';
import { useUserNameField } from '../hooks/useUserName';
import { useSmartPinSort } from '../hooks/useSmartPinSort';
import {
  useAiAssistantPref,
  useAiCapability,
  useGeminiHelpersPref,
  type AiStatus,
} from '../hooks/useGeminiHelpers';
import { useOracleHintPref } from '../hooks/useOracleHintPref';
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

// Reusable label + description + switch row. Keeps every toggle in Settings
// visually identical (a consistency win the old ad-hoc rows lacked).
function ToggleRow({
  title,
  hint,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="body2" sx={{ color: disabled ? 'text.disabled' : 'text.primary' }}>
          {title}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {hint}
        </Typography>
      </Box>
      <Switch checked={checked} disabled={disabled} onChange={(_, v) => onChange(v)} />
    </Box>
  );
}

// Proactive on-device-AI availability banner. The whole point of the AI tab:
// tell Edge / Firefox / Safari / mainland-China users UP FRONT what's going
// on and reassure them that the rest of Augur works without it — rather than
// letting them discover a dead button by clicking it.
function AiAvailabilityBanner({ status }: { status: AiStatus }) {
  const { t } = useTranslation();
  const variant =
    status === 'available'
      ? { color: 'success' as const, icon: <CheckCircleIcon />, title: t('settings.aiReadyTitle'), body: t('settings.aiReadyBody') }
      : status === 'downloadable' || status === 'downloading'
        ? { color: 'info' as const, icon: <DownloadIcon />, title: t('settings.aiDownloadableTitle'), body: t('settings.aiDownloadableBody') }
        : status === 'checking'
          ? { color: 'info' as const, icon: <InfoOutlinedIcon />, title: t('settings.aiCheckingTitle'), body: '' }
          : { color: 'warning' as const, icon: <InfoOutlinedIcon />, title: t('settings.aiUnavailableTitle'), body: t('settings.aiUnavailableBody') };
  const tint =
    variant.color === 'success'
      ? 'rgba(46, 160, 67, 0.12)'
      : variant.color === 'warning'
        ? 'rgba(217, 119, 6, 0.12)'
        : 'var(--mui-palette-action-hover)';
  return (
    <Box sx={{ display: 'flex', gap: 1.5, p: 1.75, borderRadius: 2, backgroundColor: tint }}>
      <Box sx={{ color: `${variant.color}.main`, display: 'flex', mt: 0.25 }}>{variant.icon}</Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {variant.title}
        </Typography>
        {variant.body && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
            {variant.body}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

export function SettingsDialog({ open, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const [userName, setStoredUserName] = useUserNameField();
  const [userNameDraft, setUserNameDraft] = useState(userName);
  const [smartPinSort, setSmartPinSort] = useSmartPinSort();
  const [oracleHintEnabled, setOracleHintEnabled] = useOracleHintPref();
  const { enabled: geminiEnabled, setEnabled: setGeminiEnabled } = useGeminiHelpersPref();
  const { status: aiStatus, available: aiAvailable } = useAiCapability();
  const [aiAssistantEnabled, setAiAssistantEnabled] = useAiAssistantPref();

  // Re-seed the draft when the dialog opens so it stays consistent with the
  // current saved value (e.g. after a wipe-all that resets the name too).
  // We don't need useEffect here — the draft state syncs on each open.
  const { summary, refresh } = useDataSummary();
  const [confirmingWipe, setConfirmingWipe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'general' | 'ai' | 'data' | 'advanced'>('general');

  const onExport = async () => {
    setBusy(true);
    try {
      const dump = await exportAllData();
      if (!dump) return;
      const blob = new Blob([JSON.stringify(dump)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `augur-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Post-import warm-up: rebuild every derived table and retrain every model
  // from the (merged) event log, in dependency order. This is what turns an
  // imported pile of events into prediction accuracy — without it a merge
  // import leaves aggregates/models reflecting only the pre-import data.
  // Each step is an existing, independently-tested RPC; failures in one step
  // don't block the rest (best-effort recovery beats all-or-nothing).
  const runWarmup = async () => {
    const steps: Array<[string, () => Promise<unknown>]> = [
      ['aggregates', rebuildAggregates],
      ['embedding', retrainEmbedding],
      ['sequence', rebuildSequenceMemory],
      ['replay', replayImplicitTraining],
      ['forest', retrainForest],
    ];
    for (const [key, run] of steps) {
      toast({ message: t('settings.warmupStep', { step: t(`settings.warmup.${key}`) }), severity: 'info' });
      try {
        await run();
      } catch {
        // keep going — partial warm-up is still a net win
      }
    }
  };

  const onImportFile = async (file: File) => {
    setBusy(true);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let parsed: unknown;
      let merge = false;
      if (isZipFile(buf)) {
        // Debug bundle → MERGE (recover lost history into the current
        // install without discarding what it has since learned).
        try {
          parsed = debugBundleToDump(buf);
        } catch {
          parsed = null;
        }
        if (!parsed) {
          toast({ message: t('settings.importBadFile'), severity: 'error' });
          return;
        }
        merge = true;
      } else {
        // JSON backup → REPLACE (restore semantics, unchanged).
        try {
          parsed = JSON.parse(new TextDecoder().decode(buf));
        } catch {
          toast({ message: t('settings.importBadFile'), severity: 'error' });
          return;
        }
      }
      const r = await importAllData(parsed, { merge });
      if (!r || !r.ok) {
        toast({
          message:
            r?.reason === 'not-augur-backup'
              ? t('settings.importNotBackup')
              : t('settings.importFailed'),
          severity: 'error',
        });
        return;
      }
      const mergedEvents = r.counts?.events ?? 0;
      toast({
        message: merge
          ? t('settings.importMerged', { count: mergedEvents })
          : t('settings.importDone'),
        severity: 'success',
      });
      // Rebuild + retrain everything on the merged history so the models are
      // warm the moment the page comes back.
      await runWarmup();
      toast({ message: t('settings.warmupDone'), severity: 'success' });
      onClose();
      // Reload so the SW re-reads the imported models + the UI re-renders.
      window.location.reload();
    } finally {
      setBusy(false);
    }
  };

  const onExportDebug = async () => {
    setBusy(true);
    try {
      const bundle = await exportDebugBundle();
      if (!bundle) {
        toast({ message: t('settings.debugExportFailed'), severity: 'error' });
        return;
      }
      // Decode base64 → Blob → download. The SW built the zip; we just
      // hand the bytes to the browser.
      const bin = atob(bundle.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = bundle.filename;
      a.click();
      URL.revokeObjectURL(url);
      toast({
        message: t('settings.debugExportDone', {
          size: (bundle.size / 1024).toFixed(0),
        }),
        severity: 'success',
      });
    } finally {
      setBusy(false);
    }
  };

  const onSeedHistory = async () => {
    setBusy(true);
    try {
      // force=true so subsequent clicks reseed (deletes prior bootstrap-tagged
      // events first, so we don't accumulate duplicates).
      const r = await seedFromBrowserHistory({ force: true });
      if (r === null) {
        toast({ message: t('settings.historyBootstrapFailed'), severity: 'error' });
        return;
      }
      if (r.skipped) {
        toast({
          message: t('settings.historyBootstrapSkipped'),
          severity: 'info',
        });
        return;
      }
      toast({
        message: t('settings.historyBootstrapDone', {
          events: r.events,
          domains: r.domains,
        }),
        severity: 'success',
      });
      await refresh();
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
          <Tab value="ai" label={t('settings.tabAi')} />
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
              <Box>
                <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
                  {t('settings.predictionsTitle')}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {t('settings.predictionsSubtitle')}
                </Typography>
              </Box>
              <ToggleRow
                title={t('settings.oracleHint')}
                hint={t('settings.oracleHintHint')}
                checked={oracleHintEnabled}
                onChange={setOracleHintEnabled}
              />
              <ToggleRow
                title={t('settings.smartPinSort')}
                hint={t('settings.smartPinSortHint')}
                checked={smartPinSort}
                onChange={setSmartPinSort}
              />
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
                {t('homepage.title')}
              </Typography>
              <SetAsHomepageGuide />
            </Stack>
          </Stack>
        )}

        {tab === 'ai' && (
          <Stack spacing={3} divider={<Divider flexItem />}>
            <AiAvailabilityBanner status={aiStatus} />
            <Stack spacing={2}>
              <ToggleRow
                title={t('settings.aiAssistant')}
                hint={
                  aiAvailable
                    ? t('settings.aiAssistantHint')
                    : t('settings.aiUnavailableShort')
                }
                checked={aiAssistantEnabled && aiAvailable}
                disabled={!aiAvailable}
                onChange={setAiAssistantEnabled}
              />
              <ToggleRow
                title={t('settings.geminiHelpers')}
                hint={
                  aiAvailable
                    ? t('settings.geminiHelpersHint')
                    : t('settings.aiUnavailableShort')
                }
                checked={geminiEnabled && aiAvailable}
                disabled={!aiAvailable}
                onChange={setGeminiEnabled}
              />
            </Stack>
            <Typography variant="caption" color="text.secondary">
              {t('settings.aiPrivacyNote')}
            </Typography>
          </Stack>
        )}

        {tab === 'data' && (
          <Stack spacing={3} divider={<Divider flexItem />}>
            {/* ── Your data summary ─────────────────────────────────── */}
            <Stack spacing={1.5}>
              <Box>
                <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
                  {t('settings.dataTitle')}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {t('settings.dataSummary')}
                </Typography>
              </Box>
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
            </Stack>

            {/* ── Backup & move to another device ───────────────────── */}
            <Stack spacing={1.5}>
              <Box>
                <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
                  {t('settings.backupTitle')}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {t('settings.backupSubtitle')}
                </Typography>
              </Box>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Tooltip title={t('settings.exportTooltip')}>
                  <span>
                    <Button
                      onClick={onExport}
                      startIcon={<DownloadIcon />}
                      disabled={busy}
                      variant="contained"
                      disableElevation
                    >
                      {t('settings.export')}
                    </Button>
                  </span>
                </Tooltip>
                <Tooltip title={t('settings.importTooltip')}>
                  <span>
                    <Button
                      onClick={() => fileInputRef.current?.click()}
                      startIcon={<UploadIcon />}
                      disabled={busy}
                      variant="outlined"
                    >
                      {t('settings.import')}
                    </Button>
                  </span>
                </Tooltip>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json,application/zip,.zip"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = ''; // allow re-selecting the same file
                    if (f) void onImportFile(f);
                  }}
                />
              </Stack>
            </Stack>

            {/* ── Other tools ───────────────────────────────────────── */}
            <Stack spacing={1.5}>
              <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
                {t('settings.toolsTitle')}
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Tooltip title={t('settings.historyBootstrapTooltip')}>
                  <span>
                    <Button
                      onClick={onSeedHistory}
                      startIcon={<HistoryIcon />}
                      disabled={busy}
                      variant="outlined"
                    >
                      {t('settings.historyBootstrap')}
                    </Button>
                  </span>
                </Tooltip>
                <Tooltip title={t('settings.debugExportTooltip')}>
                  <span>
                    <Button
                      onClick={onExportDebug}
                      startIcon={<BugReportIcon />}
                      disabled={busy}
                      variant="outlined"
                    >
                      {t('settings.debugExport')}
                    </Button>
                  </span>
                </Tooltip>
              </Stack>
            </Stack>

            {/* ── Reset (danger zone) ───────────────────────────────── */}
            <Stack spacing={1.5}>
              <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
                {t('settings.dangerZoneTitle')}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {t('settings.privacyHint')}
              </Typography>
              <Box>
                {confirmingWipe ? (
                  <Stack direction="row" spacing={1}>
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
                  </Stack>
                ) : (
                  <Button
                    onClick={() => setConfirmingWipe(true)}
                    startIcon={<RestartAltIcon />}
                    variant="outlined"
                    color="error"
                    disabled={busy}
                  >
                    {t('settings.wipe')}
                  </Button>
                )}
              </Box>
            </Stack>
          </Stack>
        )}

        {tab === 'advanced' && <ModelDebugPanel />}
      </DialogContent>
    </Dialog>
  );
}
