import { extendTheme } from '@mui/material/styles';

// Augur · Paper theme
//
// Visual language ported from the Claude desktop app:
//   - Warm off-white "paper" canvas, slightly tinted sidebars
//   - Hairline 1px borders instead of glass / shadows
//   - Coral accent for the brand mark and active state, used sparingly
//   - Editorial serif for the largest display heading; system sans for body
//   - Soft, restrained rounding (8 / 12 / 16 — no inflation)
//
// What this theme is NOT: glassmorphism, vibrant gradients, dense color.
// Everything stays calm and book-like; the orange asterisk does the work
// of "this is alive".

const SANS =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", Helvetica, Arial, sans-serif';
const SERIF =
  '"Iowan Old Style", "Charter", "Source Serif Pro", "Cambria", Georgia, serif';

// Coral / terracotta palette used for the brand mark and primary action.
const CORAL = '#C2410C';
const CORAL_LIGHT = '#FED7AA';
const CORAL_DARK = '#9A3412';
const CORAL_ON_DARK = '#E58660';

const LIGHT = {
  bg: '#F5F2EB',           // outer canvas (warm cream)
  paper: '#FCFAF5',        // cards, dialogs (slightly lighter)
  paperRaised: '#FFFFFF',  // raised surfaces if needed
  text: '#1F1E1B',
  textSecondary: 'rgba(31, 30, 27, 0.62)',
  divider: 'rgba(31, 30, 27, 0.08)',
  border: 'rgba(31, 30, 27, 0.10)',
  hover: 'rgba(31, 30, 27, 0.05)',
  selected: 'rgba(31, 30, 27, 0.08)',
};

const DARK = {
  bg: '#1B1815',
  paper: '#262220',
  paperRaised: '#2D2925',
  text: '#F1ECE2',
  textSecondary: 'rgba(241, 236, 226, 0.62)',
  divider: 'rgba(241, 236, 226, 0.08)',
  border: 'rgba(241, 236, 226, 0.12)',
  hover: 'rgba(241, 236, 226, 0.06)',
  selected: 'rgba(241, 236, 226, 0.10)',
};

export const theme = extendTheme({
  cssVarPrefix: 'mui',
  colorSchemes: {
    light: {
      palette: {
        primary: {
          main: CORAL,
          light: CORAL_LIGHT,
          dark: CORAL_DARK,
          contrastText: '#FFFFFF',
        },
        secondary: { main: '#3E5C76', contrastText: '#FFFFFF' },
        background: { default: LIGHT.bg, paper: LIGHT.paper },
        text: { primary: LIGHT.text, secondary: LIGHT.textSecondary },
        divider: LIGHT.divider,
        warning: { main: '#B45309' },
        error: { main: '#B91C1C' },
        success: { main: '#15803D' },
      },
    },
    dark: {
      palette: {
        primary: {
          main: CORAL_ON_DARK,
          light: '#3D1F0E',
          dark: CORAL_LIGHT,
          contrastText: '#1B1815',
        },
        secondary: { main: '#94B1C9', contrastText: '#1B1815' },
        background: { default: DARK.bg, paper: DARK.paper },
        text: { primary: DARK.text, secondary: DARK.textSecondary },
        divider: DARK.divider,
        warning: { main: '#FBBF24' },
        error: { main: '#F87171' },
        success: { main: '#34D399' },
      },
    },
  },
  // Tame radius scale — Claude leans on hairlines + whitespace, not big curves.
  // pill = 999 · 2xl = 16 (Dialog) · xl = 12 (Card) · lg = 10 (Menu/Input)
  // md = 8 (Toggle, Chip) · sm = 6 (MenuItem) · xs = 4 (Heatmap, micro)
  shape: { borderRadius: 12 },
  typography: {
    fontFamily: SANS,
    // Display headings use the editorial serif. Body sticks to the system sans.
    h1: {
      fontFamily: SERIF,
      fontSize: '2.75rem',
      fontWeight: 400,
      lineHeight: 1.1,
      letterSpacing: '-0.015em',
    },
    h2: {
      fontFamily: SERIF,
      fontSize: '2.125rem',
      fontWeight: 400,
      lineHeight: 1.15,
      letterSpacing: '-0.01em',
    },
    h3: {
      fontFamily: SERIF,
      fontSize: '1.625rem',
      fontWeight: 500,
      lineHeight: 1.2,
    },
    h4: { fontSize: '1.25rem', fontWeight: 600, letterSpacing: '-0.005em' },
    h5: { fontSize: '1.05rem', fontWeight: 600 },
    h6: { fontSize: '0.95rem', fontWeight: 600 },
    body1: { fontSize: '0.95rem', lineHeight: 1.55 },
    body2: { fontSize: '0.85rem', lineHeight: 1.5 },
    button: { textTransform: 'none', fontWeight: 500, letterSpacing: 0 },
    caption: { fontSize: '0.75rem', lineHeight: 1.4 },
  },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          borderRadius: 999,
          paddingInline: 16,
          paddingBlock: 6,
          minHeight: 32,
          fontWeight: 500,
          boxShadow: 'none',
          transition:
            'background-color 150ms ease, color 150ms ease, border-color 150ms ease',
          '&:hover': { boxShadow: 'none' },
        },
        outlined: ({ theme: t }) => ({
          borderColor: LIGHT.border,
          color: 'var(--mui-palette-text-primary)',
          '&:hover': {
            backgroundColor: LIGHT.hover,
            borderColor: LIGHT.border,
          },
          ...t.applyStyles('dark', {
            borderColor: DARK.border,
            '&:hover': {
              backgroundColor: DARK.hover,
              borderColor: DARK.border,
            },
          }),
        }),
        text: ({ theme: t }) => ({
          color: 'var(--mui-palette-text-primary)',
          '&:hover': { backgroundColor: LIGHT.hover },
          ...t.applyStyles('dark', {
            '&:hover': { backgroundColor: DARK.hover },
          }),
        }),
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: ({ theme: t }) => ({
          borderRadius: 8,
          color: 'var(--mui-palette-text-primary)',
          '&:hover': { backgroundColor: LIGHT.hover },
          ...t.applyStyles('dark', {
            '&:hover': { backgroundColor: DARK.hover },
          }),
        }),
      },
    },
    MuiCard: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: ({ theme: t }) => ({
          borderRadius: 12,
          backgroundImage: 'none',
          backgroundColor: LIGHT.paper,
          border: `1px solid ${LIGHT.border}`,
          boxShadow: 'none',
          transition: 'background-color 150ms ease, border-color 150ms ease',
          ...t.applyStyles('dark', {
            backgroundColor: DARK.paper,
            border: `1px solid ${DARK.border}`,
          }),
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
          backgroundColor: 'rgba(245, 242, 235, 0.85)',
          backdropFilter: 'saturate(140%) blur(14px)',
          WebkitBackdropFilter: 'saturate(140%) blur(14px)',
          borderBottom: `1px solid ${LIGHT.divider}`,
          color: 'var(--mui-palette-text-primary)',
          boxShadow: 'none',
          ...t.applyStyles('dark', {
            backgroundColor: 'rgba(27, 24, 21, 0.85)',
            borderBottom: `1px solid ${DARK.divider}`,
          }),
        }),
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: ({ theme: t }) => ({
          borderRadius: 16,
          backgroundImage: 'none',
          backgroundColor: LIGHT.paper,
          border: `1px solid ${LIGHT.border}`,
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.10)',
          ...t.applyStyles('dark', {
            backgroundColor: DARK.paper,
            border: `1px solid ${DARK.border}`,
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
          }),
        }),
      },
    },
    MuiMenu: {
      defaultProps: { slotProps: { list: { sx: { p: 0.5 } } } },
      styleOverrides: {
        paper: ({ theme: t }) => ({
          borderRadius: 10,
          backgroundImage: 'none',
          backgroundColor: LIGHT.paper,
          border: `1px solid ${LIGHT.border}`,
          boxShadow: '0 4px 16px rgba(0, 0, 0, 0.08)',
          ...t.applyStyles('dark', {
            backgroundColor: DARK.paper,
            border: `1px solid ${DARK.border}`,
            boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
          }),
        }),
      },
    },
    MuiMenuItem: {
      styleOverrides: {
        root: ({ theme: t }) => ({
          marginInline: 4,
          marginBlock: 1,
          paddingInline: 10,
          paddingBlock: 6,
          borderRadius: 6,
          fontSize: '0.875rem',
          minHeight: 32,
          '&:hover': { backgroundColor: LIGHT.hover },
          '&.Mui-selected': {
            backgroundColor: 'rgba(194, 65, 12, 0.10)',
            color: CORAL,
            '&:hover': { backgroundColor: 'rgba(194, 65, 12, 0.16)' },
          },
          ...t.applyStyles('dark', {
            '&:hover': { backgroundColor: DARK.hover },
            '&.Mui-selected': {
              backgroundColor: 'rgba(229, 134, 96, 0.16)',
              color: CORAL_ON_DARK,
              '&:hover': { backgroundColor: 'rgba(229, 134, 96, 0.24)' },
            },
          }),
        }),
      },
    },
    MuiPopover: {
      styleOverrides: {
        paper: ({ theme: t }) => ({
          backgroundImage: 'none',
          backgroundColor: LIGHT.paper,
          border: `1px solid ${LIGHT.border}`,
          boxShadow: '0 4px 16px rgba(0, 0, 0, 0.08)',
          ...t.applyStyles('dark', {
            backgroundColor: DARK.paper,
            border: `1px solid ${DARK.border}`,
            boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
          }),
        }),
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          borderRadius: 6,
          backgroundColor: 'rgba(31, 30, 27, 0.92)',
          color: '#FCFAF5',
          fontSize: '0.75rem',
          paddingBlock: 5,
          paddingInline: 9,
        },
        arrow: { color: 'rgba(31, 30, 27, 0.92)' },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: ({ theme: t }) => ({
          borderRadius: 6,
          fontWeight: 500,
          fontSize: '0.75rem',
          height: 24,
          backgroundColor: 'rgba(31, 30, 27, 0.06)',
          color: 'var(--mui-palette-text-primary)',
          ...t.applyStyles('dark', {
            backgroundColor: 'rgba(241, 236, 226, 0.08)',
          }),
        }),
        outlined: ({ theme: t }) => ({
          backgroundColor: 'transparent',
          borderColor: LIGHT.border,
          ...t.applyStyles('dark', { borderColor: DARK.border }),
        }),
        filled: {
          // Coral chip for "selected" emphasis
        },
        colorPrimary: ({ theme: t }) => ({
          backgroundColor: 'rgba(194, 65, 12, 0.10)',
          color: CORAL,
          ...t.applyStyles('dark', {
            backgroundColor: 'rgba(229, 134, 96, 0.18)',
            color: CORAL_ON_DARK,
          }),
        }),
      },
    },
    MuiToggleButtonGroup: {
      styleOverrides: {
        root: ({ theme: t }) => ({
          padding: 2,
          borderRadius: 8,
          backgroundColor: 'rgba(31, 30, 27, 0.05)',
          border: `1px solid ${LIGHT.border}`,
          ...t.applyStyles('dark', {
            backgroundColor: 'rgba(241, 236, 226, 0.05)',
            border: `1px solid ${DARK.border}`,
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
          borderRadius: '6px !important',
          paddingInline: 10,
          paddingBlock: 4,
          fontSize: 12,
          minHeight: 0,
          '&.Mui-selected': {
            backgroundColor: '#FCFAF5',
            color: 'var(--mui-palette-text-primary)',
            boxShadow: '0 1px 2px rgba(0, 0, 0, 0.06)',
          },
          ...t.applyStyles('dark', {
            '&.Mui-selected': {
              backgroundColor: 'rgba(241, 236, 226, 0.10)',
              color: 'var(--mui-palette-text-primary)',
              boxShadow: 'none',
            },
          }),
        }),
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: ({ theme: t }) => ({
          borderRadius: 10,
          backgroundColor: LIGHT.paper,
          '& .MuiOutlinedInput-notchedOutline': {
            borderColor: LIGHT.border,
          },
          '&:hover .MuiOutlinedInput-notchedOutline': {
            borderColor: 'rgba(31, 30, 27, 0.20)',
          },
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
            borderColor: CORAL,
            borderWidth: 1,
          },
          ...t.applyStyles('dark', {
            backgroundColor: DARK.paper,
            '& .MuiOutlinedInput-notchedOutline': {
              borderColor: DARK.border,
            },
            '&:hover .MuiOutlinedInput-notchedOutline': {
              borderColor: 'rgba(241, 236, 226, 0.20)',
            },
            '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
              borderColor: CORAL_ON_DARK,
            },
          }),
        }),
      },
    },
    MuiSelect: {
      styleOverrides: {
        outlined: ({ theme: t }) => ({
          backgroundColor: LIGHT.paper,
          ...t.applyStyles('dark', { backgroundColor: DARK.paper }),
        }),
      },
    },
    MuiTabs: {
      styleOverrides: {
        indicator: {
          height: 2,
          borderRadius: 1,
          backgroundColor: CORAL,
        },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 500,
          minHeight: 36,
          fontSize: '0.875rem',
          '&.Mui-selected': { color: CORAL },
        },
      },
    },
    MuiAlert: {
      styleOverrides: {
        root: { borderRadius: 8 },
      },
    },
    MuiSnackbarContent: {
      styleOverrides: {
        root: { borderRadius: 999 },
      },
    },
    MuiCheckbox: {
      styleOverrides: {
        root: { borderRadius: 4, padding: 4 },
      },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: {
          backgroundColor: 'rgba(31, 30, 27, 0.08)',
        },
        bar: { backgroundColor: CORAL },
      },
    },
  },
});
