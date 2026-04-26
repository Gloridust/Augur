import { useTranslation } from 'react-i18next';
import { AppBar, Box, IconButton, Toolbar, Tooltip, Typography } from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import { AugurMark } from './AugurMark';
import { NavSearchBar } from './NavSearchBar';
import { AiAssistant } from './AiAssistant';

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
          minHeight: { xs: 56, md: 64 },
          px: { xs: 1.5, md: 2.5 },
        }}
      >
        {/* Brand cluster — flower-ball mark + Italiana display wordmark.
            Italiana is a free, single-stroke artistic Italian serif — gives
            the name a flowing, designed feel without a custom logotype. */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.25,
            flexShrink: 0,
            color: 'text.primary',
          }}
        >
          <Box sx={{ color: 'var(--mui-palette-primary-main)', display: 'flex' }}>
            <AugurMark size={28} />
          </Box>
          <Typography
            component="span"
            sx={{
              fontFamily: '"Italiana", "Iowan Old Style", Georgia, serif',
              fontSize: { xs: 24, md: 28 },
              lineHeight: 1,
              letterSpacing: '0.06em',
              color: 'text.primary',
              userSelect: 'none',
            }}
          >
            Augur
          </Typography>
        </Box>

        {/* Spacer pushes search + settings to the right. */}
        <Box sx={{ flex: 1 }} />

        <NavSearchBar />

        <AiAssistant />

        <Tooltip title={t('actions.settings')}>
          <IconButton onClick={onOpenSettings}>
            <SettingsIcon />
          </IconButton>
        </Tooltip>
      </Toolbar>
    </AppBar>
  );
}
