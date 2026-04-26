import { extendTheme } from '@mui/material/styles';

// Material Design 3 baseline tonal palette (seed: M3 baseline purple 6750A4),
// adapted for a dashboard context. Color tokens follow MD3 naming.
export const theme = extendTheme({
  cssVarPrefix: 'mui',
  colorSchemes: {
    light: {
      palette: {
        primary: {
          main: '#6750A4',
          light: '#EADDFF',
          dark: '#21005D',
          contrastText: '#FFFFFF',
        },
        secondary: {
          main: '#625B71',
          light: '#E8DEF8',
          dark: '#1D192B',
          contrastText: '#FFFFFF',
        },
        background: {
          default: '#FEF7FF',
          paper: '#FFFFFF',
        },
        text: {
          primary: '#1D1B20',
          secondary: '#49454F',
        },
        divider: 'rgba(29, 27, 32, 0.08)',
        warning: { main: '#B3261E' },
      },
    },
    dark: {
      palette: {
        primary: {
          main: '#D0BCFF',
          light: '#4F378B',
          dark: '#EADDFF',
          contrastText: '#21005D',
        },
        secondary: {
          main: '#CCC2DC',
          light: '#4A4458',
          dark: '#E8DEF8',
          contrastText: '#332D41',
        },
        background: {
          default: '#141218',
          paper: '#1D1B20',
        },
        text: {
          primary: '#E6E0E9',
          secondary: '#CAC4D0',
        },
        divider: 'rgba(230, 224, 233, 0.12)',
        warning: { main: '#F2B8B5' },
      },
    },
  },
  shape: { borderRadius: 16 },
  typography: {
    fontFamily:
      "'Roboto Flex', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    h1: { fontSize: '3.5rem', fontWeight: 400, letterSpacing: '-0.02em' },
    h2: { fontSize: '2.5rem', fontWeight: 400, letterSpacing: '-0.01em' },
    h3: { fontSize: '2rem', fontWeight: 500 },
    h4: { fontSize: '1.5rem', fontWeight: 500 },
    h5: { fontSize: '1.25rem', fontWeight: 500 },
    h6: { fontSize: '1rem', fontWeight: 500 },
    body1: { fontSize: '1rem', lineHeight: 1.5 },
    body2: { fontSize: '0.875rem', lineHeight: 1.43 },
    button: { textTransform: 'none', fontWeight: 500, letterSpacing: '0.01em' },
  },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          borderRadius: 999,
          paddingInline: 24,
          paddingBlock: 10,
          minHeight: 40,
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: { borderRadius: 12 },
      },
    },
    MuiCard: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: {
          borderRadius: 16,
          backgroundColor: 'var(--mui-palette-background-paper)',
          border: '1px solid var(--mui-palette-divider)',
          transition:
            'background-color 200ms cubic-bezier(0.2, 0, 0, 1), border-color 200ms cubic-bezier(0.2, 0, 0, 1), transform 200ms cubic-bezier(0.2, 0, 0, 1)',
        },
      },
    },
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: { backgroundImage: 'none' },
      },
    },
    MuiAppBar: {
      defaultProps: { elevation: 0, color: 'transparent' },
      styleOverrides: {
        root: {
          backgroundColor: 'transparent',
          backdropFilter: 'saturate(140%) blur(12px)',
          WebkitBackdropFilter: 'saturate(140%) blur(12px)',
          borderBottom: '1px solid var(--mui-palette-divider)',
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          borderRadius: 8,
          fontSize: '0.75rem',
          paddingBlock: 6,
          paddingInline: 10,
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { borderRadius: 8, fontWeight: 500 },
      },
    },
  },
});
