import { Box } from '@mui/material';
import type { SearchEngine } from '../hooks/useSearchEngine';

// Tiny brand glyph for the search-engine selector. Letter on a colored disk
// — recognizable but doesn't infringe on logos. Sizes follow the input height.
export function EngineGlyph({
  engine,
  size = 22,
}: {
  engine: SearchEngine;
  size?: number;
}) {
  const config =
    engine === 'google'
      ? { letter: 'G', bg: 'linear-gradient(135deg, #4285F4 0%, #34A853 100%)' }
      : { letter: 'b', bg: 'linear-gradient(135deg, #008373 0%, #00B5AD 100%)' };

  return (
    <Box
      aria-hidden
      sx={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: config.bg,
        display: 'grid',
        placeItems: 'center',
        color: '#fff',
        fontSize: size * 0.55,
        fontWeight: 700,
        lineHeight: 1,
        fontFamily: '"Helvetica Neue", Arial, sans-serif',
        flexShrink: 0,
        boxShadow: '0 1px 2px rgba(0,0,0,0.10)',
      }}
    >
      {config.letter}
    </Box>
  );
}
