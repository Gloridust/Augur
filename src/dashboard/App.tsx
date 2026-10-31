import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Container, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import SpaIcon from '@mui/icons-material/Spa';
import { AugurMark } from './components/AugurMark';
import { NavSearchBar } from './components/NavSearchBar';
import { useZenMode } from './hooks/useZenMode';
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
import { OracleHint } from './components/OracleHint';
import { SettingsDialog } from './components/SettingsDialog';
import { Toaster } from './components/Toaster';

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [zen, setZen] = useZenMode();
  const { t } = useTranslation();

  if (zen) {
    // Zen: the brand and the launcher, nothing else to glance at.
    return (
      <Box sx={{ minHeight: '100vh', backgroundColor: 'background.default', display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 0.5, p: { xs: 1, md: 2 } }}>
          <Tooltip title={t('launcher.zenExit')}>
            <IconButton aria-label={t('launcher.zenExit')} onClick={() => setZen(false)}>
              <SpaIcon sx={{ color: 'primary.main' }} />
            </IconButton>
          </Tooltip>
          <Tooltip title={t('actions.settings')}>
            <IconButton aria-label={t('actions.settings')} onClick={() => setSettingsOpen(true)}>
              <SettingsIcon />
            </IconButton>
          </Tooltip>
        </Box>
        <Stack
          alignItems="center"
          spacing={{ xs: 3, md: 4 }}
          sx={{ flex: 1, justifyContent: 'center', px: 2, pb: '18vh' }}
        >
          <Stack direction="row" alignItems="center" spacing={1.5} sx={{ color: 'text.primary' }}>
            <Box sx={{ color: 'var(--mui-palette-primary-main)', display: 'flex' }}>
              <AugurMark size={40} />
            </Box>
            <Typography
              component="h1"
              sx={{ fontFamily: '"Italiana", "Iowan Old Style", Georgia, serif', fontSize: { xs: 40, md: 52 }, lineHeight: 1, letterSpacing: '0.04em' }}
            >
              Augur
            </Typography>
          </Stack>
          <NavSearchBar variant="hero" />
        </Stack>
        <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        <Toaster />
      </Box>
    );
  }

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
      <OracleHint />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <Toaster />
    </Box>
  );
}
