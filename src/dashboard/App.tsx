import { useState } from 'react';
import { Box, Container, Stack } from '@mui/material';
import { AppHeader } from './components/AppHeader';
import { Greeting } from './components/Greeting';
import { TabWall } from './components/TabWall';
import { Suggestions } from './components/Suggestions';
import { StashSection } from './components/StashSection';
import { WorkspacesSection } from './components/WorkspacesSection';
import { TodayRecap } from './components/TodayRecap';
import { PinsRow } from './components/PinsRow';
import { Insights } from './components/Insights';
import { Onboarding } from './components/Onboarding';
import { SettingsDialog } from './components/SettingsDialog';
import { Toaster } from './components/Toaster';

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <Box sx={{ minHeight: '100vh', backgroundColor: 'background.default' }}>
      <AppHeader onOpenSettings={() => setSettingsOpen(true)} />
      {/* maxWidth=false so we can opt into a custom 1800px ceiling — the
          default `xl` is 1536px which leaves big empty gutters on 2K+ screens. */}
      <Container
        maxWidth={false}
        sx={{
          py: { xs: 3, md: 4 },
          px: { xs: 2, sm: 3, md: 4, lg: 5 },
          mx: 'auto',
          maxWidth: 1800,
        }}
      >
        <Stack spacing={{ xs: 3, md: 4 }}>
          {/* Hero: greeting on the left, today's recap on the right (wraps on
              narrow). The web search lives in the navbar — no duplicate hero
              search. */}
          <Box
            sx={{
              display: 'grid',
              gap: { xs: 2, lg: 3 },
              gridTemplateColumns: {
                xs: '1fr',
                md: 'auto 1fr',
              },
              alignItems: 'center',
            }}
          >
            <Greeting />
            <TodayRecap />
          </Box>

          {/* Pinned shortcuts — single horizontal row above the hero so
              fast-access sites are always one click away. Auto-hides when
              the user has nothing pinned. */}
          <PinsRow />

          {/* Above-the-fold workspace: smart suggestions on the left,
              currently open tabs (with inline cleanup) on the right. */}
          <Box
            sx={{
              display: 'grid',
              gap: { xs: 3, lg: 3 },
              gridTemplateColumns: {
                xs: '1fr',
                lg: 'minmax(0, 1fr) minmax(0, 1fr)',
              },
              alignItems: 'flex-start',
            }}
          >
            <Suggestions dense />
            <TabWall dense />
          </Box>

          <WorkspacesSection />

          <StashSection />

          <Insights />
        </Stack>
      </Container>

      <Onboarding />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <Toaster />
    </Box>
  );
}
