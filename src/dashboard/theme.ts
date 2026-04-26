import { extendTheme } from '@mui/material/styles';

// Augur · Liquid Glass theme
//
// Design intent: every visible surface (cards, app bar, dialogs, menus,
// inputs, chips) is a translucent layer over a soft animated gradient
// backdrop. The blur + saturate filter does the heavy lifting; we add a
// thin top-left specular highlight via inset shadow + a hairline edge to
// suggest light catching the glass curvature.
//
// What's faked vs real iOS 26:
//   ✓ Backdrop blur + saturation pickup
//   ✓ Specular highlight at top edge
//   ✓ Hairline edge (one device pixel)
//   ✓ Soft outer drop-shadow at low opacity
//   ✗ Real-time refraction / lensing under the glass (would need WebGL)
//   ✗ Shape morph during state transitions (would need View Transitions)
//
// All glass surfaces share the same recipe — defining it once here as a
// component override keeps the look consistent across every MUI primitive.

const SF_FONT_STACK =
  '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif';

// The "glass recipe" — referenced by every surface. Kept as a constant so
// hover / active / focus variations can layer on top instead of redeclaring.
const GLASS_BG_LIGHT = 'rgba(255, 255, 255, 0.55)';
const GLASS_BG_LIGHT_STRONG = 'rgba(255, 255, 255, 0.72)';
const GLASS_BG_DARK = 'rgba(28, 28, 30, 0.55)';
const GLASS_BG_DARK_STRONG = 'rgba(40, 40, 44, 0.72)';

const GLASS_BORDER_LIGHT = 'rgba(255, 255, 255, 0.6)';
const GLASS_BORDER_DARK = 'rgba(255, 255, 255, 0.10)';

const GLASS_HIGHLIGHT_LIGHT = 'rgba(255, 255, 255, 0.85)';
const GLASS_HIGHLIGHT_DARK = 'rgba(255, 255, 255, 0.16)';

const GLASS_SHADOW_LIGHT =
  '0 1px 2px rgba(28, 28, 30, 0.05), 0 8px 28px rgba(28, 28, 30, 0.08)';
const GLASS_SHADOW_DARK =
  '0 1px 2px rgba(0, 0, 0, 0.5), 0 12px 40px rgba(0, 0, 0, 0.45)';

// Common backdrop-filter — `saturate(180%)` gives the iOS pickup effect where
// the glass intensifies the colour of whatever sits behind it.
const GLASS_BLUR = 'saturate(180%) blur(28px)';

const glassSurface = (mode: 'light' | 'dark') => ({
  backgroundColor: mode === 'light' ? GLASS_BG_LIGHT : GLASS_BG_DARK,
  backdropFilter: GLASS_BLUR,
  WebkitBackdropFilter: GLASS_BLUR,
  // Hairline border + inner top highlight to hint at curvature.
  border: `0.5px solid ${mode === 'light' ? GLASS_BORDER_LIGHT : GLASS_BORDER_DARK}`,
  boxShadow: `inset 0 1px 0 ${mode === 'light' ? GLASS_HIGHLIGHT_LIGHT : GLASS_HIGHLIGHT_DARK}, ${
    mode === 'light' ? GLASS_SHADOW_LIGHT : GLASS_SHADOW_DARK
  }`,
});

export const theme = extendTheme({
  cssVarPrefix: 'mui',
  colorSchemes: {
    light: {
      palette: {
        primary: {
          main: '#7C3AED',
          light: '#C4B5FD',
          dark: '#5B21B6',
          contrastText: '#FFFFFF',
        },
        secondary: {
          main: '#0EA5E9',
          light: '#BAE6FD',
          dark: '#0369A1',
          contrastText: '#FFFFFF',
        },
        background: {
          // Base sits behind the gradient mesh that styles.css paints.
          default: '#F4F0FA',
          paper: GLASS_BG_LIGHT_STRONG,
        },
        text: {
          primary: '#1B1530',
          secondary: 'rgba(27, 21, 48, 0.62)',
        },
        divider: 'rgba(27, 21, 48, 0.08)',
        warning: { main: '#D97706' },
        error: { main: '#DC2626' },
        success: { main: '#059669' },
      },
    },
    dark: {
      palette: {
        primary: {
          main: '#A78BFA',
          light: '#1E1B3A',
          dark: '#DDD6FE',
          contrastText: '#1B1530',
        },
        secondary: {
          main: '#38BDF8',
          light: '#082F49',
          dark: '#BAE6FD',
          contrastText: '#062B43',
        },
        background: {
          default: '#0E0B1F',
          paper: GLASS_BG_DARK_STRONG,
        },
        text: {
          primary: '#F4F0FA',
          secondary: 'rgba(244, 240, 250, 0.65)',
        },
        divider: 'rgba(244, 240, 250, 0.10)',
        warning: { main: '#FBBF24' },
        error: { main: '#F87171' },
        success: { main: '#34D399' },
      },
    },
  },
  shape: { borderRadius: 18 },
  typography: {
    fontFamily: SF_FONT_STACK,
    h1: { fontSize: '3.25rem', fontWeight: 600, letterSpacing: '-0.025em' },
    h2: { fontSize: '2.25rem', fontWeight: 600, letterSpacing: '-0.02em' },
    h3: { fontSize: '1.75rem', fontWeight: 600, letterSpacing: '-0.015em' },
    h4: { fontSize: '1.4rem', fontWeight: 600, letterSpacing: '-0.01em' },
    h5: { fontSize: '1.15rem', fontWeight: 600 },
    h6: { fontSize: '1rem', fontWeight: 600 },
    body1: { fontSize: '0.95rem', lineHeight: 1.5 },
    body2: { fontSize: '0.85rem', lineHeight: 1.45 },
    button: { textTransform: 'none', fontWeight: 600, letterSpacing: 0 },
    caption: { fontSize: '0.75rem' },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          // The animated gradient mesh that gives the glass something to
          // refract. Defined here so it survives MUI's CssBaseline reset.
          backgroundColor: 'var(--mui-palette-background-default)',
        },
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true, disableRipple: false },
      styleOverrides: {
        root: ({ theme: t }) => ({
          borderRadius: 999,
          paddingInline: 22,
          paddingBlock: 9,
          minHeight: 36,
          fontWeight: 600,
          letterSpacing: 0,
          backdropFilter: GLASS_BLUR,
          WebkitBackdropFilter: GLASS_BLUR,
          transition:
            'transform 200ms cubic-bezier(0.2, 0, 0, 1), background-color 200ms cubic-bezier(0.2, 0, 0, 1), box-shadow 200ms cubic-bezier(0.2, 0, 0, 1)',
          '&:hover': { transform: 'translateY(-0.5px)' },
          '&:active': { transform: 'translateY(0.5px)' },
          // Mode-aware overrides
          ...t.applyStyles('light', {}),
        }),
        contained: ({ theme: t }) => ({
          boxShadow: `inset 0 1px 0 rgba(255,255,255,0.35), ${GLASS_SHADOW_LIGHT}`,
          ...t.applyStyles('dark', {
            boxShadow: `inset 0 1px 0 rgba(255,255,255,0.18), ${GLASS_SHADOW_DARK}`,
          }),
        }),
        outlined: ({ theme: t }) => ({
          backgroundColor: GLASS_BG_LIGHT,
          border: `0.5px solid ${GLASS_BORDER_LIGHT}`,
          color: 'var(--mui-palette-text-primary)',
          '&:hover': {
            backgroundColor: GLASS_BG_LIGHT_STRONG,
            border: `0.5px solid ${GLASS_BORDER_LIGHT}`,
          },
          ...t.applyStyles('dark', {
            backgroundColor: GLASS_BG_DARK,
            border: `0.5px solid ${GLASS_BORDER_DARK}`,
            '&:hover': {
              backgroundColor: GLASS_BG_DARK_STRONG,
              border: `0.5px solid ${GLASS_BORDER_DARK}`,
            },
          }),
        }),
        text: ({ theme: t }) => ({
          backdropFilter: 'none',
          WebkitBackdropFilter: 'none',
          '&:hover': {
            backgroundColor: 'rgba(124, 58, 237, 0.08)',
          },
          ...t.applyStyles('dark', {
            '&:hover': { backgroundColor: 'rgba(167, 139, 250, 0.10)' },
          }),
        }),
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: ({ theme: t }) => ({
          borderRadius: 12,
          transition: 'background-color 200ms cubic-bezier(0.2, 0, 0, 1)',
          '&:hover': {
            backgroundColor: 'rgba(27, 21, 48, 0.06)',
          },
          ...t.applyStyles('dark', {
            '&:hover': { backgroundColor: 'rgba(244, 240, 250, 0.08)' },
          }),
        }),
      },
    },
    MuiCard: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: ({ theme: t }) => ({
          borderRadius: 20,
          backgroundImage: 'none',
          ...glassSurface('light'),
          ...t.applyStyles('dark', glassSurface('dark')),
          transition:
            'background-color 220ms cubic-bezier(0.2, 0, 0, 1), border-color 220ms cubic-bezier(0.2, 0, 0, 1), transform 220ms cubic-bezier(0.2, 0, 0, 1)',
        }),
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
        root: ({ theme: t }) => ({
          backgroundColor: 'rgba(244, 240, 250, 0.55)',
          backdropFilter: GLASS_BLUR,
          WebkitBackdropFilter: GLASS_BLUR,
          borderBottom: `0.5px solid ${GLASS_BORDER_LIGHT}`,
          boxShadow: 'none',
          color: 'var(--mui-palette-text-primary)',
          ...t.applyStyles('dark', {
            backgroundColor: 'rgba(14, 11, 31, 0.55)',
            borderBottom: `0.5px solid ${GLASS_BORDER_DARK}`,
          }),
        }),
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: ({ theme: t }) => ({
          borderRadius: 28,
          backgroundImage: 'none',
          ...glassSurface('light'),
          ...t.applyStyles('dark', glassSurface('dark')),
        }),
      },
    },
    MuiMenu: {
      styleOverrides: {
        paper: ({ theme: t }) => ({
          borderRadius: 14,
          backgroundImage: 'none',
          ...glassSurface('light'),
          ...t.applyStyles('dark', glassSurface('dark')),
        }),
      },
    },
    MuiPopover: {
      styleOverrides: {
        paper: ({ theme: t }) => ({
          backgroundImage: 'none',
          ...glassSurface('light'),
          ...t.applyStyles('dark', glassSurface('dark')),
        }),
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          borderRadius: 10,
          fontSize: '0.75rem',
          paddingBlock: 6,
          paddingInline: 10,
          backgroundColor: 'rgba(27, 21, 48, 0.85)',
          backdropFilter: 'blur(12px)',
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: ({ theme: t }) => ({
          borderRadius: 10,
          fontWeight: 500,
          backgroundColor: 'rgba(255, 255, 255, 0.6)',
          backdropFilter: GLASS_BLUR,
          border: `0.5px solid ${GLASS_BORDER_LIGHT}`,
          ...t.applyStyles('dark', {
            backgroundColor: 'rgba(40, 40, 44, 0.55)',
            border: `0.5px solid ${GLASS_BORDER_DARK}`,
          }),
        }),
        filled: {
          // Filled chips (e.g. "selected") keep a solid look.
          backdropFilter: 'none',
        },
        outlined: ({ theme: t }) => ({
          backgroundColor: 'transparent',
          backdropFilter: 'none',
          ...t.applyStyles('dark', { backgroundColor: 'transparent' }),
        }),
      },
    },
    MuiToggleButtonGroup: {
      styleOverrides: {
        root: ({ theme: t }) => ({
          padding: 2,
          borderRadius: 999,
          backgroundColor: 'rgba(255, 255, 255, 0.5)',
          backdropFilter: GLASS_BLUR,
          border: `0.5px solid ${GLASS_BORDER_LIGHT}`,
          ...t.applyStyles('dark', {
            backgroundColor: 'rgba(40, 40, 44, 0.45)',
            border: `0.5px solid ${GLASS_BORDER_DARK}`,
          }),
        }),
      },
    },
    MuiToggleButton: {
      styleOverrides: {
        root: ({ theme: t }) => ({
          border: 'none !important',
          color: 'var(--mui-palette-text-secondary)',
          textTransform: 'none',
          fontWeight: 500,
          '&.Mui-selected': {
            backgroundColor: 'rgba(255, 255, 255, 0.85) !important',
            color: 'var(--mui-palette-text-primary)',
            boxShadow: GLASS_SHADOW_LIGHT,
          },
          ...t.applyStyles('dark', {
            '&.Mui-selected': {
              backgroundColor: 'rgba(60, 60, 65, 0.85) !important',
              color: 'var(--mui-palette-text-primary)',
              boxShadow: GLASS_SHADOW_DARK,
            },
          }),
        }),
      },
    },
    MuiSelect: {
      styleOverrides: {
        outlined: ({ theme: t }) => ({
          borderRadius: 14,
          backgroundColor: 'rgba(255, 255, 255, 0.5)',
          backdropFilter: GLASS_BLUR,
          ...t.applyStyles('dark', {
            backgroundColor: 'rgba(40, 40, 44, 0.45)',
          }),
        }),
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: ({ theme: t }) => ({
          borderRadius: 14,
          backgroundColor: 'rgba(255, 255, 255, 0.5)',
          backdropFilter: GLASS_BLUR,
          '& .MuiOutlinedInput-notchedOutline': {
            borderColor: GLASS_BORDER_LIGHT,
            borderWidth: '0.5px !important',
          },
          ...t.applyStyles('dark', {
            backgroundColor: 'rgba(40, 40, 44, 0.45)',
            '& .MuiOutlinedInput-notchedOutline': {
              borderColor: GLASS_BORDER_DARK,
            },
          }),
        }),
      },
    },
    MuiCheckbox: {
      styleOverrides: {
        root: { borderRadius: 6 },
      },
    },
    MuiTabs: {
      styleOverrides: {
        indicator: {
          height: 3,
          borderRadius: 999,
        },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: { textTransform: 'none', fontWeight: 600, minHeight: 40 },
      },
    },
    MuiAlert: {
      styleOverrides: {
        root: ({ theme: t }) => ({
          borderRadius: 14,
          backdropFilter: GLASS_BLUR,
          ...t.applyStyles('dark', {}),
        }),
      },
    },
    MuiSnackbarContent: {
      styleOverrides: {
        root: {
          borderRadius: 999,
          backdropFilter: GLASS_BLUR,
        },
      },
    },
  },
});
