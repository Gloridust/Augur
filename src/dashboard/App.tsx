import { useCallback, useState } from 'react';
import { Box, Container, Stack } from '@mui/material';
import { AppHeader } from './components/AppHeader';
import { Greeting } from './components/Greeting';
import { SearchBar } from './components/SearchBar';
import { TabWall } from './components/TabWall';
import { Suggestions } from './components/Suggestions';
import { CleanupSuggestions } from './components/CleanupSuggestions';
import { StashSection } from './components/StashSection';
import { WorkspacesSection } from './components/WorkspacesSection';
import { TodayRecap } from './components/TodayRecap';
import { Insights } from './components/Insights';
import { Onboarding } from './components/Onboarding';
import { SettingsDialog } from './components/SettingsDialog';
import { CommandPalette } from './components/CommandPalette';
import { Toaster } from './components/Toaster';
import { useCommandPaletteShortcut } from './hooks/useGlobalShortcut';

export default function App() {
  const [query, setQuery] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  useCommandPaletteShortcut(openPalette);

  return (
    <Box sx={{ minHeight: '100vh', backgroundColor: 'background.default' }}>
      <AppHeader
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenPalette={openPalette}
      />
      <Container maxWidth="xl" sx={{ py: { xs: 4, md: 6 } }}>
        <Stack spacing={{ xs: 4, md: 6 }}>
          <Stack spacing={3}>
            <Greeting />
            <TodayRecap />
            <SearchBar onChange={setQuery} />
          </Stack>

          <Suggestions />

          <TabWall filter={query} />

          <WorkspacesSection />

          <StashSection />

          <CleanupSuggestions />

          <Insights />
        </Stack>
      </Container>

      <Onboarding />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <Toaster />
    </Box>
  );
}
