import { useTranslation } from 'react-i18next';
import {
  AppBar,
  Box,
  Chip,
  IconButton,
  Stack,
  Toolbar,
  Tooltip,
} from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import SearchIcon from '@mui/icons-material/Search';

interface Props {
  onOpenSettings: () => void;
  onOpenPalette: () => void;
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

export function AppHeader({ onOpenSettings, onOpenPalette }: Props) {
  const { t } = useTranslation();

  return (
    <AppBar position="sticky">
      <Toolbar sx={{ gap: 1, minHeight: { xs: 48, md: 56 } }}>
        <Box sx={{ flex: 1 }} />

        <Tooltip title={t('palette.shortcutHint')}>
          <Chip
            icon={<SearchIcon fontSize="small" />}
            onClick={onOpenPalette}
            label={
              <Stack direction="row" spacing={0.5} alignItems="center">
                <span>{t('palette.openCta')}</span>
                <Box
                  component="kbd"
                  sx={{
                    fontFamily: 'inherit',
                    fontSize: 11,
                    px: 0.75,
                    py: 0.1,
                    borderRadius: 1,
                    border: '1px solid var(--mui-palette-divider)',
                    backgroundColor: 'var(--mui-palette-action-hover)',
                    color: 'text.secondary',
                  }}
                >
                  {isMac ? '⌘K' : 'Ctrl+K'}
                </Box>
              </Stack>
            }
            sx={{
              cursor: 'pointer',
              borderRadius: 999,
              backgroundColor: 'var(--mui-palette-action-hover)',
              border: '1px solid var(--mui-palette-divider)',
              height: 36,
              px: 1,
              mr: 0.5,
              '& .MuiChip-label': { px: 1 },
              '&:hover': { backgroundColor: 'var(--mui-palette-action-selected)' },
            }}
          />
        </Tooltip>

        <Tooltip title={t('actions.settings')}>
          <IconButton onClick={onOpenSettings}>
            <SettingsIcon />
          </IconButton>
        </Tooltip>
      </Toolbar>
    </AppBar>
  );
}
