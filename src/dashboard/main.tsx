import React from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline } from '@mui/material';
import { CssVarsProvider, getInitColorSchemeScript } from '@mui/material/styles';
import App from './App';
import { theme } from './theme';
import './i18n';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('root not found');

createRoot(container).render(
  <React.StrictMode>
    {/* getInitColorSchemeScript prevents the brief flash of light theme on
        first paint when the user prefers dark — it inlines the right
        attribute on <html> before React mounts. */}
    {getInitColorSchemeScript({
      attribute: 'data-mui-color-scheme',
      modeStorageKey: 'augur:mode',
      defaultMode: 'system',
    })}
    <CssVarsProvider
      theme={theme}
      defaultMode="system"
      modeStorageKey="augur:mode"
      attribute="data-mui-color-scheme"
    >
      <CssBaseline />
      <App />
    </CssVarsProvider>
  </React.StrictMode>,
);
