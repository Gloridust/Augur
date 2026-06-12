import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import ModelTrainingIcon from '@mui/icons-material/ModelTraining';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import ForestIcon from '@mui/icons-material/Forest';
import TimelineIcon from '@mui/icons-material/Timeline';
import ReplayIcon from '@mui/icons-material/Replay';
import HubIcon from '@mui/icons-material/Hub';
import QueryStatsIcon from '@mui/icons-material/QueryStats';
import type { ModelInspection } from '../../ml/data-ops';
import {
  evaluateModel,
  fetchModelInspection,
  rebuildAggregates,
  rebuildSequenceMemory,
  replayImplicitTraining,
  resetModelsOnly,
  retrainEmbedding,
  retrainForest,
  type EvalReportData,
} from '../api/recommendations';
import { toast } from './Toaster';

function WeightBar({ weight, max }: { weight: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (Math.abs(weight) / max) * 100) : 0;
  const positive = weight >= 0;
  return (
    <Box sx={{ position: 'relative', height: 6, width: 120 }}>
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          borderRadius: 999,
          backgroundColor: 'var(--mui-palette-action-hover)',
        }}
      />
      <Box
        sx={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: positive ? '50%' : `${50 - pct / 2}%`,
          width: `${pct / 2}%`,
          borderRadius: 999,
          backgroundColor: positive
            ? 'var(--mui-palette-primary-main)'
            : 'var(--mui-palette-warning-main)',
        }}
      />
      <Box
        sx={{
          position: 'absolute',
          top: -2,
          bottom: -2,
          left: '50%',
          width: 1,
          backgroundColor: 'var(--mui-palette-divider)',
        }}
      />
    </Box>
  );
}

function HeadCard({
  title,
  weights,
  bias,
  trainedSamples,
  positiveSamples,
  calibA,
  calibB,
  calibSamples,
  calibLabel,
}: {
  title: string;
  weights: Array<{ name: string; weight: number }>;
  bias: number;
  trainedSamples: number;
  positiveSamples: number;
  calibA: number;
  calibB: number;
  calibSamples: number;
  calibLabel: string;
}) {
  const max = Math.max(0.01, ...weights.map((w) => Math.abs(w.weight)));
  const sorted = [...weights].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  return (
    <Card sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 1, flexWrap: 'wrap' }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
          {title}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          bias {bias.toFixed(3)} · samples {trainedSamples} / {positiveSamples} pos
        </Typography>
      </Box>
      <Stack direction="row" spacing={0.5} sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap>
        <Chip
          size="small"
          label={`${calibLabel}: a=${calibA.toFixed(3)} b=${calibB.toFixed(3)} · n=${calibSamples}`}
          sx={{ height: 20, fontFamily: 'monospace', fontSize: 10 }}
          variant="outlined"
        />
      </Stack>
      <Stack spacing={0.75}>
        {sorted.map((w) => (
          <Box
            key={w.name}
            sx={{ display: 'flex', alignItems: 'center', gap: 1.5, fontSize: 12 }}
          >
            <Typography
              variant="caption"
              sx={{
                width: 220,
                fontFamily: 'monospace',
                color: 'text.secondary',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={w.name}
            >
              {w.name}
            </Typography>
            <WeightBar weight={w.weight} max={max} />
            <Typography
              variant="caption"
              sx={{
                width: 64,
                fontFamily: 'monospace',
                textAlign: 'right',
                color: w.weight >= 0 ? 'primary.main' : 'warning.main',
              }}
            >
              {w.weight >= 0 ? '+' : ''}
              {w.weight.toFixed(3)}
            </Typography>
          </Box>
        ))}
      </Stack>
    </Card>
  );
}

function BanditCard({
  title,
  rows,
}: {
  title: string;
  rows: ModelInspection['bandits']['cleanup'];
}) {
  return (
    <Card sx={{ p: 2 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 500, mb: 1.5 }}>
        {title}
      </Typography>
      {rows.length === 0 ? (
        <Typography variant="caption" color="text.secondary">
          —
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {rows.map((r) => (
            <Box
              key={r.id}
              sx={{ display: 'flex', alignItems: 'center', gap: 1.5, fontSize: 12 }}
            >
              <Typography
                variant="caption"
                sx={{
                  flex: 1,
                  fontFamily: 'monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: 'text.secondary',
                }}
                title={r.id}
              >
                {r.id}
              </Typography>
              <Tooltip title={`α=${r.alpha.toFixed(2)} β=${r.beta.toFixed(2)}`}>
                <Box sx={{ width: 80, height: 6, position: 'relative' }}>
                  <Box
                    sx={{
                      position: 'absolute',
                      inset: 0,
                      borderRadius: 999,
                      backgroundColor: 'var(--mui-palette-action-hover)',
                    }}
                  />
                  <Box
                    sx={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      left: 0,
                      width: `${(r.mean * 100).toFixed(1)}%`,
                      borderRadius: 999,
                      backgroundColor: 'var(--mui-palette-primary-main)',
                    }}
                  />
                </Box>
              </Tooltip>
              <Typography
                variant="caption"
                sx={{ width: 48, fontFamily: 'monospace', textAlign: 'right' }}
              >
                {(r.mean * 100).toFixed(0)}%
              </Typography>
              <Typography
                variant="caption"
                sx={{ width: 36, fontFamily: 'monospace', textAlign: 'right', color: 'text.secondary' }}
              >
                ×{r.impressions}
              </Typography>
            </Box>
          ))}
        </Stack>
      )}
    </Card>
  );
}

export function ModelDebugPanel() {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<ModelInspection | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const d = await fetchModelInspection();
      setData(d);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const [confirmingReset, setConfirmingReset] = useState(false);

  const onRetrain = async () => {
    setBusy(true);
    try {
      const r = await retrainEmbedding();
      await refresh();
      if (r) {
        toast({
          message: t('toasts.embedRetrained', { steps: r.steps, vocab: r.vocab }),
          severity: 'success',
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const onRetrainForest = async () => {
    setBusy(true);
    try {
      const r = await retrainForest();
      await refresh();
      if (r) {
        toast({
          message: t('toasts.forestRetrained', {
            samples: r.trained,
            pos: r.posSamples,
            neg: r.negSamples,
          }),
          severity: r.trained > 0 ? 'success' : 'info',
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const onRebuildSequence = async () => {
    setBusy(true);
    try {
      const r = await rebuildSequenceMemory();
      await refresh();
      if (r) {
        toast({
          message: t('toasts.sequenceRebuilt', {
            observed: r.observed,
            keys: r.bigramKeys,
          }),
          severity: 'success',
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const onReplayLR = async () => {
    setBusy(true);
    try {
      const r = await replayImplicitTraining();
      await refresh();
      if (r) {
        toast({
          message: t('toasts.lrReplayed', {
            open: r.openSamples,
            cleanup: r.cleanupSamples,
          }),
          severity: 'success',
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const onRebuildAggregates = async () => {
    setBusy(true);
    try {
      await rebuildAggregates();
      await refresh();
      toast({ message: t('toasts.aggregatesRebuilt'), severity: 'success' });
    } finally {
      setBusy(false);
    }
  };

  const [evalResult, setEvalResult] = useState<EvalReportData | null>(null);
  const onEvaluate = async () => {
    setBusy(true);
    try {
      const r = await evaluateModel(60);
      if (r) setEvalResult(r);
      else toast({ message: t('debug.evaluateFailed'), severity: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const onResetModels = async () => {
    setBusy(true);
    try {
      await resetModelsOnly();
      setConfirmingReset(false);
      await refresh();
      toast({ message: t('toasts.modelsReset'), severity: 'success' });
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  const embedUpdated =
    data.embedding.updatedAt > 0
      ? new Intl.DateTimeFormat(i18n.language, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(data.embedding.updatedAt))
      : t('settings.never');

  return (
    <Stack spacing={2} divider={<Divider flexItem />}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 500, flex: 1 }}>
          {t('debug.heads')}
        </Typography>
        {confirmingReset ? (
          <>
            <Button
              size="small"
              variant="contained"
              color="error"
              startIcon={<RestartAltIcon />}
              onClick={onResetModels}
              disabled={busy}
            >
              {t('debug.resetConfirm')}
            </Button>
            <Button size="small" onClick={() => setConfirmingReset(false)} disabled={busy}>
              {t('settings.cancel')}
            </Button>
          </>
        ) : (
          <Button
            size="small"
            color="error"
            startIcon={<RestartAltIcon />}
            onClick={() => setConfirmingReset(true)}
            disabled={busy}
            variant="text"
          >
            {t('debug.resetModels')}
          </Button>
        )}
        <Button
          size="small"
          startIcon={<RefreshIcon />}
          onClick={refresh}
          disabled={busy}
          variant="text"
        >
          {t('actions.refresh')}
        </Button>
      </Box>
      <HeadCard
        title={t('debug.cleanupHead')}
        weights={data.cleanup.weights}
        bias={data.cleanup.bias}
        trainedSamples={data.cleanup.trainedSamples}
        positiveSamples={data.cleanup.positiveSamples}
        calibA={data.cleanup.calibA}
        calibB={data.cleanup.calibB}
        calibSamples={data.cleanup.calibSamples}
        calibLabel={t('debug.calibration')}
      />
      <HeadCard
        title={t('debug.recommendHead')}
        weights={data.recommend.weights}
        bias={data.recommend.bias}
        trainedSamples={data.recommend.trainedSamples}
        positiveSamples={data.recommend.positiveSamples}
        calibA={data.recommend.calibA}
        calibB={data.recommend.calibB}
        calibSamples={data.recommend.calibSamples}
        calibLabel={t('debug.calibration')}
      />

      <Box>
        <Typography variant="subtitle1" sx={{ fontWeight: 500, mb: 1 }}>
          {t('debug.manualTraining')}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
          {t('debug.manualTrainingHint')}
        </Typography>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Tooltip title={t('debug.retrainForestTooltip')}>
            <span>
              <Button
                size="small"
                variant="outlined"
                startIcon={<ForestIcon />}
                onClick={onRetrainForest}
                disabled={busy}
              >
                {t('debug.retrainForest')}
              </Button>
            </span>
          </Tooltip>
          <Tooltip title={t('debug.rebuildSequenceTooltip')}>
            <span>
              <Button
                size="small"
                variant="outlined"
                startIcon={<TimelineIcon />}
                onClick={onRebuildSequence}
                disabled={busy}
              >
                {t('debug.rebuildSequence')}
              </Button>
            </span>
          </Tooltip>
          <Tooltip title={t('debug.replayLRTooltip')}>
            <span>
              <Button
                size="small"
                variant="outlined"
                startIcon={<ReplayIcon />}
                onClick={onReplayLR}
                disabled={busy}
              >
                {t('debug.replayLR')}
              </Button>
            </span>
          </Tooltip>
          <Tooltip title={t('debug.rebuildAggregatesTooltip')}>
            <span>
              <Button
                size="small"
                variant="outlined"
                startIcon={<HubIcon />}
                onClick={onRebuildAggregates}
                disabled={busy}
              >
                {t('debug.rebuildAggregates')}
              </Button>
            </span>
          </Tooltip>
        </Stack>
      </Box>

      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 500, flex: 1 }}>
            {t('debug.evaluation')}
          </Typography>
          <Tooltip title={t('debug.evaluateTooltip')}>
            <span>
              <Button
                size="small"
                variant="outlined"
                startIcon={<QueryStatsIcon />}
                onClick={onEvaluate}
                disabled={busy}
              >
                {t('debug.evaluate')}
              </Button>
            </span>
          </Tooltip>
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
          {t('debug.evaluationHint')}
        </Typography>
        {evalResult && (
          <Card sx={{ p: 2 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              {t('debug.evaluatedOn', {
                n: evalResult.evaluated,
                ms: evalResult.tookMs,
              })}
            </Typography>
            <Box
              component="table"
              sx={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 13,
                '& th, & td': {
                  textAlign: 'right',
                  py: 0.5,
                  px: 1,
                  borderBottom: '1px solid var(--mui-palette-divider)',
                },
                '& th:first-of-type, & td:first-of-type': { textAlign: 'left' },
              }}
            >
              <thead>
                <tr>
                  <th>{t('debug.metric')}</th>
                  <th>{t('debug.modelCol')}</th>
                  <th>{t('debug.baselineCol')}</th>
                  <th>Δ</th>
                </tr>
              </thead>
              <tbody>
                {(['hit1', 'hit3', 'hit5', 'mrr'] as const).map((k) => {
                  const m = evalResult.model[k];
                  const b = evalResult.baseline[k];
                  const delta = m - b;
                  return (
                    <tr key={k}>
                      <td>{k === 'mrr' ? 'MRR' : `hit@${k.slice(3)}`}</td>
                      <td>{(m * 100).toFixed(1)}%</td>
                      <td>{(b * 100).toFixed(1)}%</td>
                      <td
                        style={{
                          color:
                            delta > 0.001
                              ? 'var(--mui-palette-success-main)'
                              : delta < -0.001
                                ? 'var(--mui-palette-error-main)'
                                : undefined,
                          fontWeight: 500,
                        }}
                      >
                        {delta >= 0 ? '+' : ''}
                        {(delta * 100).toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Box>
          </Card>
        )}
      </Box>

      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 500, flex: 1 }}>
            {t('debug.embedding')}
          </Typography>
          <Button
            size="small"
            variant="outlined"
            startIcon={<ModelTrainingIcon />}
            onClick={onRetrain}
            disabled={busy}
          >
            {t('debug.retrainEmbedding')}
          </Button>
        </Box>
        <Card sx={{ p: 2 }}>
          <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
            <Chip label={`${t('debug.dim')}: ${data.embedding.dim}`} size="small" />
            <Chip label={`${t('debug.vocab')}: ${data.embedding.vocabSize}`} size="small" />
            <Chip
              label={`${t('debug.steps')}: ${data.embedding.trainedSteps.toLocaleString()}`}
              size="small"
            />
            <Chip label={`${t('debug.updated')}: ${embedUpdated}`} size="small" />
          </Stack>
          {data.embedding.sampleNeighbors.length === 0 ? (
            <Typography variant="caption" color="text.secondary">
              {t('debug.embeddingEmpty')}
            </Typography>
          ) : (
            <Stack spacing={2}>
              {data.embedding.sampleNeighbors.map((s) => (
                <Box key={s.domain}>
                  <Typography
                    variant="caption"
                    sx={{ fontFamily: 'monospace', color: 'text.secondary' }}
                  >
                    {s.domain}
                  </Typography>
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                    {s.neighbors.map((n) => (
                      <Chip
                        key={n.domain}
                        size="small"
                        label={`${n.domain} · ${(n.cosine * 100).toFixed(0)}%`}
                        sx={{ height: 22 }}
                      />
                    ))}
                  </Stack>
                </Box>
              ))}
            </Stack>
          )}
        </Card>
      </Box>

      <Box>
        <Typography variant="subtitle1" sx={{ fontWeight: 500, mb: 1.5 }}>
          {t('debug.bandits')}
        </Typography>
        <Stack spacing={2}>
          <BanditCard title={t('debug.cleanupBandit')} rows={data.bandits.cleanup} />
          <BanditCard title={t('debug.recommendBandit')} rows={data.bandits.recommend} />
        </Stack>
      </Box>
    </Stack>
  );
}
