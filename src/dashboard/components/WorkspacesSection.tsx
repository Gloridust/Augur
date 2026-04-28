import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  Box,
  Button,
  Card,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import LayersIcon from '@mui/icons-material/Layers';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import OpenInBrowserIcon from '@mui/icons-material/OpenInBrowser';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import SaveIcon from '@mui/icons-material/Save';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import {
  suggestWorkspaceName,
  useGeminiHelpersPref,
} from '../hooks/useGeminiHelpers';
import { extractDomain } from '../../shared/db';
import type { Workspace, WorkspaceTab } from '../../shared/types';
import {
  deleteWorkspaceById,
  listWorkspaces,
  renameWorkspace,
  restoreWorkspace,
  saveWorkspace,
  updateWorkspaceTabs,
} from '../api/recommendations';
import { useTabs } from '../hooks/useTabs';
import { toast } from './Toaster';

function favicon(t: WorkspaceTab): string {
  if (t.favIconUrl) return t.favIconUrl;
  try {
    return `https://www.google.com/s2/favicons?sz=64&domain=${new URL(t.url).hostname}`;
  } catch {
    return '';
  }
}

function tabsFromCurrent(tabs: chrome.tabs.Tab[]): WorkspaceTab[] {
  return tabs
    .filter((t) => !!t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'))
    .map((t) => ({
      url: t.url ?? '',
      title: t.title ?? '',
      favIconUrl: t.favIconUrl,
      pinned: !!t.pinned,
    }));
}

function relativeTime(ts: number, locale: string): string {
  const ms = Date.now() - ts;
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const min = ms / 60_000;
  if (min < 1) return fmt.format(0, 'minute');
  if (min < 60) return fmt.format(-Math.round(min), 'minute');
  const hr = min / 60;
  if (hr < 24) return fmt.format(-Math.round(hr), 'hour');
  return fmt.format(-Math.round(hr / 24), 'day');
}

interface SaveDialogProps {
  open: boolean;
  onClose: () => void;
  defaultName: string;
  tabs: WorkspaceTab[];
  onSaved: () => void;
}

function SaveDialog({ open, onClose, defaultName, tabs, onSaved }: SaveDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const { enabled: geminiEnabled, apiAvailable } = useGeminiHelpersPref();
  const showSuggestButton = geminiEnabled && apiAvailable;

  useEffect(() => {
    if (open) setName(defaultName);
  }, [open, defaultName]);

  const onSuggest = async () => {
    if (suggesting || tabs.length === 0) return;
    setSuggesting(true);
    try {
      const domains = Array.from(
        new Set(tabs.map((tb) => extractDomain(tb.url)).filter(Boolean)),
      );
      const suggested = await suggestWorkspaceName(domains);
      if (suggested) setName(suggested);
    } finally {
      setSuggesting(false);
    }
  };

  const onSave = async () => {
    if (!name.trim() || tabs.length === 0) return;
    setBusy(true);
    try {
      await saveWorkspace(name.trim(), tabs);
      toast({
        message: t('toasts.workspaceSaved', { count: tabs.length, name: name.trim() }),
        severity: 'success',
      });
      onSaved();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth slotProps={{ paper: { sx: { borderRadius: 4 } } }}>
      <DialogTitle>{t('workspaces.saveTitle')}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Stack direction="row" spacing={1} alignItems="flex-end">
            <TextField
              autoFocus
              fullWidth
              label={t('workspaces.nameLabel')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void onSave();
                }
              }}
            />
            {showSuggestButton && (
              <Tooltip title={t('workspaces.suggestNameTooltip')}>
                <span>
                  <IconButton
                    onClick={onSuggest}
                    disabled={suggesting || tabs.length === 0}
                    sx={{
                      color: 'primary.main',
                      mb: 0.5,
                    }}
                  >
                    <AutoAwesomeIcon />
                  </IconButton>
                </span>
              </Tooltip>
            )}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {t('workspaces.captureCount', { count: tabs.length })}
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy}>
          {t('settings.cancel')}
        </Button>
        <Button
          onClick={onSave}
          variant="contained"
          startIcon={<SaveIcon />}
          disabled={busy || !name.trim() || tabs.length === 0}
        >
          {t('workspaces.save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function WorkspacesSection() {
  const { t, i18n } = useTranslation();
  const { tabs } = useTabs();
  const [items, setItems] = useState<Workspace[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<{ ws: Workspace; anchor: HTMLElement } | null>(null);
  const [renameFor, setRenameFor] = useState<Workspace | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const refresh = useCallback(async () => {
    setItems(await listWorkspaces());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const candidate = tabsFromCurrent(tabs);
  const defaultName = (() => {
    const today = new Intl.DateTimeFormat(i18n.language, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date());
    return t('workspaces.defaultName', { date: today });
  })();

  const restore = async (ws: Workspace, mode: 'newWindow' | 'currentWindow') => {
    if (ws.id === undefined) return;
    await restoreWorkspace(ws.id, mode);
    toast({
      message: t('toasts.workspaceRestored', { count: ws.tabs.length, name: ws.name }),
      severity: 'success',
    });
  };

  const updateFromCurrent = async (ws: Workspace) => {
    if (ws.id === undefined) return;
    await updateWorkspaceTabs(ws.id, candidate);
    await refresh();
    toast({ message: t('toasts.workspaceUpdated'), severity: 'success' });
  };

  const onRename = async () => {
    if (!renameFor || renameFor.id === undefined || !renameValue.trim()) return;
    await renameWorkspace(renameFor.id, renameValue.trim());
    setRenameFor(null);
    await refresh();
  };

  const onDelete = async (ws: Workspace) => {
    if (ws.id === undefined) return;
    await deleteWorkspaceById(ws.id);
    await refresh();
    toast({ message: t('toasts.workspaceDeleted', { name: ws.name }), severity: 'info' });
  };

  // Hide entirely if there are no workspaces and no current tabs to save —
  // keeps the dashboard minimal for new users until they create one.
  if (items.length === 0 && candidate.length === 0) return null;

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, flexWrap: 'wrap' }}>
        <LayersIcon sx={{ color: 'text.secondary' }} />
        <Typography variant="h5">{t('sections.workspaces')}</Typography>
        {items.length > 0 && <Chip label={items.length} size="small" />}
        <Box sx={{ flex: 1 }} />
        <Button
          variant="outlined"
          startIcon={<SaveIcon />}
          onClick={() => setSaveOpen(true)}
          disabled={candidate.length === 0}
        >
          {t('workspaces.saveCurrent')}
        </Button>
      </Box>

      {items.length === 0 ? (
        <Card sx={{ p: 4, textAlign: 'center', borderStyle: 'dashed' }}>
          <Typography variant="body2" color="text.secondary">
            {t('workspaces.empty')}
          </Typography>
        </Card>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: {
              xs: '1fr',
              sm: 'repeat(2, 1fr)',
              md: 'repeat(3, 1fr)',
              lg: 'repeat(4, 1fr)',
              xl: 'repeat(5, 1fr)',
            },
          }}
        >
          {items.map((ws) => (
            <Card key={ws.id} sx={{ p: 2 }}>
              <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography
                    variant="subtitle1"
                    sx={{
                      fontWeight: 500,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {ws.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t('workspaces.tabCount', { count: ws.tabs.length })} ·{' '}
                    {relativeTime(ws.updatedAt, i18n.language)}
                  </Typography>
                </Box>
                <IconButton
                  size="small"
                  onClick={(e) => setMenuFor({ ws, anchor: e.currentTarget })}
                  aria-label={t('workspaces.menu')}
                >
                  <MoreVertIcon fontSize="small" />
                </IconButton>
              </Box>

              <Stack direction="row" spacing={-0.5} sx={{ my: 1.5 }}>
                {ws.tabs.slice(0, 6).map((tt, i) => (
                  <Avatar
                    key={i}
                    src={favicon(tt)}
                    variant="rounded"
                    sx={{
                      width: 28,
                      height: 28,
                      bgcolor: 'transparent',
                      border: '2px solid var(--mui-palette-background-paper)',
                    }}
                  />
                ))}
                {ws.tabs.length > 6 && (
                  <Avatar
                    variant="rounded"
                    sx={{
                      width: 28,
                      height: 28,
                      fontSize: 11,
                      border: '2px solid var(--mui-palette-background-paper)',
                      bgcolor: 'var(--mui-palette-action-selected)',
                      color: 'text.primary',
                    }}
                  >
                    +{ws.tabs.length - 6}
                  </Avatar>
                )}
              </Stack>

              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {ws.domains.slice(0, 3).map((d) => (
                  <Chip key={d} label={d} size="small" sx={{ height: 20 }} />
                ))}
                {ws.domains.length > 3 && (
                  <Chip
                    label={`+${ws.domains.length - 3}`}
                    size="small"
                    sx={{ height: 20 }}
                    variant="outlined"
                  />
                )}
              </Stack>

              <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
                <Tooltip title={t('workspaces.openHere')}>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<OpenInBrowserIcon />}
                    onClick={() => restore(ws, 'currentWindow')}
                  >
                    {t('workspaces.here')}
                  </Button>
                </Tooltip>
                <Tooltip title={t('workspaces.openInNewWindow')}>
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={<OpenInNewIcon />}
                    onClick={() => restore(ws, 'newWindow')}
                  >
                    {t('workspaces.newWindow')}
                  </Button>
                </Tooltip>
              </Stack>
            </Card>
          ))}
        </Box>
      )}

      <Menu
        anchorEl={menuFor?.anchor ?? null}
        open={!!menuFor}
        onClose={() => setMenuFor(null)}
        slotProps={{ paper: { sx: { borderRadius: 3 } } }}
      >
        <MenuItem
          onClick={() => {
            if (menuFor) {
              setRenameFor(menuFor.ws);
              setRenameValue(menuFor.ws.name);
            }
            setMenuFor(null);
          }}
        >
          {t('workspaces.rename')}
        </MenuItem>
        <MenuItem
          disabled={candidate.length === 0}
          onClick={async () => {
            if (menuFor) await updateFromCurrent(menuFor.ws);
            setMenuFor(null);
          }}
        >
          {t('workspaces.updateFromCurrent')}
        </MenuItem>
        <MenuItem
          onClick={async () => {
            if (menuFor) await onDelete(menuFor.ws);
            setMenuFor(null);
          }}
          sx={{ color: 'error.main' }}
        >
          {t('workspaces.delete')}
        </MenuItem>
      </Menu>

      <SaveDialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        defaultName={defaultName}
        tabs={candidate}
        onSaved={refresh}
      />

      <Dialog
        open={!!renameFor}
        onClose={() => setRenameFor(null)}
        maxWidth="xs"
        fullWidth
        slotProps={{ paper: { sx: { borderRadius: 4 } } }}
      >
        <DialogTitle>{t('workspaces.renameTitle')}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            sx={{ mt: 1 }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void onRename();
              }
            }}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setRenameFor(null)}>{t('settings.cancel')}</Button>
          <Button onClick={onRename} variant="contained">
            {t('workspaces.save')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
