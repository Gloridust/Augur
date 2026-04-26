import { useTranslation } from 'react-i18next';
import { AppBar, Box, IconButton, Toolbar, Tooltip, Typography } from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import { AugurMark } from './AugurMark';
import { NavSearchBar } from './NavSearchBar';

interface Props {
  onOpenSettings: () => void;
}

export function AppHeader({ onOpenSettings }: Props) {
  const { t } = useTranslation();
  return (
    <AppBar position="sticky">
      <Toolbar
        sx={{
          gap: { xs: 1, md: 2 },
          minHeight: { xs: 52, md: 60 },
          px: { xs: 1.5, md: 2.5 },
        }}
      >
        {/* Brand · serif wordmark + coral asterisk so the page has identity
            without screaming for attention. */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            flexShrink: 0,
            color: 'text.primary',
          }}
        >
          <Box sx={{ color: 'var(--mui-palette-primary-main)', display: 'flex' }}>
            <AugurMark size={20} />
          </Box>
          <Typography
            variant="h5"
            component="span"
            sx={{
              fontWeight: 500,
              letterSpacing: '-0.005em',
              display: { xs: 'none', sm: 'inline' },
            }}
          >
            Augur
          </Typography>
        </Box>

        <NavSearchBar />

        <Tooltip title={t('actions.settings')}>
          <IconButton onClick={onOpenSettings}>
            <SettingsIcon />
          </IconButton>
        </Tooltip>
      </Toolbar>
    </AppBar>
  );
}
