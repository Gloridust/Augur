import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  CircularProgress,
  IconButton,
  InputBase,
  LinearProgress,
  Paper,
  Popover,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import RefreshIcon from '@mui/icons-material/Refresh';
import SendIcon from '@mui/icons-material/Send';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import { useGeminiChat, type ChatStatus } from '../hooks/useGeminiChat';

// "Augur AI" — wand-icon button in the nav. Click opens a small popover
// chat panel below it, talking to Chrome's on-device Gemini Nano. No keys,
// no network. The conversation auto-clears after 30 min of inactivity (the
// hook owns that timer); a refresh icon in the panel header lets the user
// wipe it manually.

function statusLabel(status: ChatStatus, t: (k: string, opts?: any) => string, progress: number) {
  switch (status) {
    case 'unsupported':
      return t('ai.statusUnsupported');
    case 'unavailable':
      return t('ai.statusUnavailable');
    case 'downloadable':
      return t('ai.statusDownloadable');
    case 'downloading':
      return t('ai.statusDownloading', { progress });
    case 'checking':
      return t('ai.statusChecking');
    default:
      return '';
  }
}

export function AiAssistant() {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { status, messages, downloadProgress, send, stop, clear, isStreaming } = useGeminiChat();

  const open = Boolean(anchor);
  const ready = status === 'available' || status === 'downloadable' || status === 'downloading';

  // Pin the scroll to the bottom whenever a new chunk arrives.
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  // Focus the input when the popover opens.
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 80);
    return () => window.clearTimeout(id);
  }, [open]);

  const onSend = () => {
    const text = draft.trim();
    if (!text || isStreaming) return;
    setDraft('');
    void send(text);
  };

  return (
    <>
      <Tooltip title={t('ai.openTooltip')}>
        <IconButton
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{
            color: open ? 'var(--mui-palette-primary-main)' : 'inherit',
          }}
          aria-label={t('ai.openTooltip')}
        >
          <AutoFixHighIcon />
        </IconButton>
      </Tooltip>

      <Popover
        open={open}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: {
            sx: {
              mt: 1,
              width: 380,
              maxWidth: 'calc(100vw - 24px)',
              borderRadius: 3,
              overflow: 'hidden',
            },
          },
        }}
      >
        <Paper elevation={0} sx={{ display: 'flex', flexDirection: 'column', maxHeight: 520 }}>
          {/* Header */}
          <Stack
            direction="row"
            alignItems="center"
            spacing={1}
            sx={{
              px: 1.75,
              py: 1.25,
              borderBottom: '1px solid var(--mui-palette-divider)',
            }}
          >
            <AutoFixHighIcon sx={{ fontSize: 18, color: 'primary.main' }} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 500, lineHeight: 1.1 }}>
                {t('ai.title')}
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', lineHeight: 1.2 }}
              >
                {t('ai.subtitle')}
              </Typography>
            </Box>
            <Tooltip title={t('ai.refresh')}>
              <span>
                <IconButton
                  size="small"
                  onClick={clear}
                  disabled={messages.length === 0 && !isStreaming}
                >
                  <RefreshIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>

          {/* Download progress strip */}
          {status === 'downloading' && (
            <LinearProgress
              variant={downloadProgress > 0 ? 'determinate' : 'indeterminate'}
              value={downloadProgress}
            />
          )}

          {/* Messages or empty state */}
          <Box
            ref={scrollRef}
            sx={{
              flex: 1,
              overflowY: 'auto',
              px: 1.75,
              py: 1.5,
              minHeight: 180,
              maxHeight: 360,
              backgroundColor: 'var(--mui-palette-background-default)',
            }}
          >
            {messages.length === 0 ? (
              <EmptyHint status={status} downloadProgress={downloadProgress} />
            ) : (
              <Stack spacing={1.25}>
                {messages.map((m) => (
                  <Box
                    key={m.id}
                    sx={{
                      display: 'flex',
                      justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start',
                    }}
                  >
                    <Box
                      sx={{
                        maxWidth: '85%',
                        px: 1.25,
                        py: 0.85,
                        borderRadius: 2,
                        fontSize: 13.5,
                        lineHeight: 1.45,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        backgroundColor:
                          m.role === 'user'
                            ? 'var(--mui-palette-primary-main)'
                            : 'var(--mui-palette-action-hover)',
                        color:
                          m.role === 'user'
                            ? 'var(--mui-palette-primary-contrastText)'
                            : 'text.primary',
                      }}
                    >
                      {m.content}
                      {m.streaming && m.content.length === 0 && (
                        <CircularProgress size={12} sx={{ ml: 0.5, color: 'inherit' }} />
                      )}
                      {m.streaming && m.content.length > 0 && <BlinkingCaret />}
                    </Box>
                  </Box>
                ))}
              </Stack>
            )}
          </Box>

          {/* Composer */}
          <Stack
            direction="row"
            spacing={0.75}
            alignItems="flex-end"
            sx={{
              borderTop: '1px solid var(--mui-palette-divider)',
              px: 1.25,
              py: 1,
            }}
          >
            <InputBase
              inputRef={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  onSend();
                }
              }}
              placeholder={
                ready ? t('ai.placeholder') : statusLabel(status, t, downloadProgress)
              }
              disabled={status === 'unsupported' || status === 'unavailable'}
              multiline
              maxRows={4}
              sx={{
                flex: 1,
                px: 1.25,
                py: 0.75,
                borderRadius: 2,
                fontSize: 13.5,
                backgroundColor: 'var(--mui-palette-action-hover)',
              }}
            />
            {isStreaming ? (
              <Tooltip title={t('ai.stop')}>
                <IconButton size="small" onClick={stop} sx={{ color: 'error.main' }}>
                  <StopCircleIcon />
                </IconButton>
              </Tooltip>
            ) : (
              <Tooltip title={t('ai.send')}>
                <span>
                  <IconButton
                    size="small"
                    onClick={onSend}
                    disabled={!draft.trim() || !ready}
                    sx={{
                      color: 'primary.contrastText',
                      backgroundColor: 'primary.main',
                      '&:hover': { backgroundColor: 'primary.dark' },
                      '&.Mui-disabled': {
                        backgroundColor: 'action.disabledBackground',
                        color: 'action.disabled',
                      },
                    }}
                  >
                    <SendIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </span>
              </Tooltip>
            )}
          </Stack>
        </Paper>
      </Popover>
    </>
  );
}

function EmptyHint({
  status,
  downloadProgress,
}: {
  status: ChatStatus;
  downloadProgress: number;
}) {
  const { t } = useTranslation();
  if (status === 'unsupported') {
    return (
      <HintBlock
        title={t('ai.unsupportedTitle')}
        body={t('ai.unsupportedBody')}
      />
    );
  }
  if (status === 'unavailable') {
    return (
      <HintBlock
        title={t('ai.unavailableTitle')}
        body={t('ai.unavailableBody')}
      />
    );
  }
  if (status === 'downloading') {
    return (
      <HintBlock
        title={t('ai.statusDownloading', { progress: downloadProgress })}
        body={t('ai.downloadingBody')}
      />
    );
  }
  return (
    <HintBlock
      title={t('ai.welcomeTitle')}
      body={t('ai.welcomeBody')}
    />
  );
}

function HintBlock({ title, body }: { title: string; body: string }) {
  return (
    <Stack
      spacing={0.75}
      sx={{
        height: '100%',
        justifyContent: 'center',
        alignItems: 'center',
        textAlign: 'center',
        py: 3,
        px: 1,
      }}
    >
      <Typography variant="body2" sx={{ fontWeight: 500 }}>
        {title}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 280 }}>
        {body}
      </Typography>
    </Stack>
  );
}

function BlinkingCaret() {
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-block',
        width: 6,
        height: 12,
        ml: 0.5,
        verticalAlign: 'text-bottom',
        backgroundColor: 'currentColor',
        opacity: 0.6,
        animation: 'augur-caret 1s step-end infinite',
        '@keyframes augur-caret': {
          '50%': { opacity: 0 },
        },
      }}
    />
  );
}
