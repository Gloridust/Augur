import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, InputBase, Paper } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';

export function SearchBar({ onChange }: { onChange?: (q: string) => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  return (
    <Paper
      elevation={0}
      sx={{
        display: 'flex',
        alignItems: 'center',
        px: 2.5,
        py: 1.25,
        borderRadius: 999,
        backgroundColor: 'var(--mui-palette-action-hover)',
        border: '1px solid var(--mui-palette-divider)',
        transition: 'background-color 200ms cubic-bezier(0.2, 0, 0, 1)',
        '&:hover': { backgroundColor: 'var(--mui-palette-action-selected)' },
        '&:focus-within': {
          backgroundColor: 'var(--mui-palette-background-paper)',
          borderColor: 'var(--mui-palette-primary-main)',
        },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', mr: 1.5, color: 'text.secondary' }}>
        <SearchIcon />
      </Box>
      <InputBase
        fullWidth
        value={value}
        placeholder={t('search.placeholder')}
        onChange={(e) => {
          setValue(e.target.value);
          onChange?.(e.target.value);
        }}
        sx={{ fontSize: '1rem' }}
      />
    </Paper>
  );
}
