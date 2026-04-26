import React from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline } from '@mui/material';
import { Experimental_CssVarsProvider as CssVarsProvider } from '@mui/material/styles';
import '@fontsource/roboto-flex/400.css';
import App from './App';
import { theme } from './theme';
import './i18n';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('root not found');

createRoot(container).render(
  <React.StrictMode>
    <CssVarsProvider theme={theme} defaultMode="system">
      <CssBaseline />
      <App />
    </CssVarsProvider>
  </React.StrictMode>,
);
