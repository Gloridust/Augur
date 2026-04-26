import { Box } from '@mui/material';
import type { SearchEngine } from '../hooks/useSearchEngine';

// Tiny glyph for the search-engine selector. A letter on a coral disk —
// follows the Augur theme so the selector reads as part of the UI rather
// than as third-party branding. Engines are still distinguished by letter
// (G / b). Sizes follow the input height.
export function EngineGlyph({
  engine,
  size = 22,
}: {
  engine: SearchEngine;
  size?: number;
}) {
  const letter = engine === 'google' ? 'G' : 'b';

  return (
    <Box
      aria-hidden
      sx={{
        width: size,
        height: size,
        borderRadius: '50%',
        background:
          'linear-gradient(135deg, var(--mui-palette-primary-main) 0%, var(--mui-palette-primary-dark) 100%)',
        display: 'grid',
        placeItems: 'center',
        color: 'var(--mui-palette-primary-contrastText)',
        fontSize: size * 0.55,
        fontWeight: 700,
        lineHeight: 1,
        fontFamily: '"Helvetica Neue", Arial, sans-serif',
        flexShrink: 0,
        boxShadow: '0 1px 2px rgba(0,0,0,0.10)',
      }}
    >
      {letter}
    </Box>
  );
}
