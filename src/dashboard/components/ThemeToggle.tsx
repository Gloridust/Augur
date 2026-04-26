import { IconButton, Tooltip } from '@mui/material';
import { useColorScheme } from '@mui/material/styles';
import LightModeIcon from '@mui/icons-material/LightMode';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import SettingsBrightnessIcon from '@mui/icons-material/SettingsBrightness';
import { useTranslation } from 'react-i18next';

export function ThemeToggle() {
  const { mode, setMode } = useColorScheme();
  const { t } = useTranslation();
  if (!mode) return null;

  const cycle = () => {
    if (mode === 'light') setMode('dark');
    else if (mode === 'dark') setMode('system');
    else setMode('light');
  };

  const Icon =
    mode === 'light' ? LightModeIcon : mode === 'dark' ? DarkModeIcon : SettingsBrightnessIcon;
  const label =
    mode === 'light'
      ? t('theme.light')
      : mode === 'dark'
        ? t('theme.dark')
        : t('theme.system');

  return (
    <Tooltip title={`${t('theme.toggle')} · ${label}`}>
      <IconButton onClick={cycle} sx={{ color: 'text.primary' }}>
        <Icon />
      </IconButton>
    </Tooltip>
  );
}
