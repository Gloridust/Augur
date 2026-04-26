import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline } from '@mui/material';
import { CssVarsProvider, useColorScheme } from '@mui/material/styles';
import '@fontsource/italiana/400.css';
import App from './App';
import { theme } from './theme';
import './i18n';
import './styles.css';

// MUI v6's CssVarsProvider toggles a `data-mui-color-scheme` attribute on
// <html> in response to setMode(). On certain MUI builds the attribute is
// not always written (or the prop name has changed between minor releases),
// so this small belt-and-suspenders writes the attribute imperatively as
// well — guarantees our CSS selectors that target html[data-mui-color-scheme]
// stay in sync.
function ApplyColorScheme() {
  const { mode, systemMode } = useColorScheme();
  useEffect(() => {
    const resolved = mode === 'system' ? systemMode : mode;
    if (resolved) {
      document.documentElement.setAttribute('data-mui-color-scheme', resolved);
    }
  }, [mode, systemMode]);
  return null;
}

const container = document.getElementById('root');
if (!container) throw new Error('root not found');

createRoot(container).render(
  <React.StrictMode>
    <CssVarsProvider
      theme={theme}
      defaultMode="system"
      modeStorageKey="augur:mode"
    >
      <CssBaseline />
      <ApplyColorScheme />
      <App />
    </CssVarsProvider>
  </React.StrictMode>,
);
