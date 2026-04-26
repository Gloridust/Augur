import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Chip,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import HomeIcon from '@mui/icons-material/Home';
import LaunchIcon from '@mui/icons-material/Launch';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import { dashboardUrl } from '../hooks/useTabs';
import { toast } from './Toaster';

export function SetAsHomepageGuide() {
  const { t } = useTranslation();
  const url = dashboardUrl();
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
      toast({ message: t('homepage.copied'), severity: 'success' });
    } catch {
      toast({ message: t('homepage.copyFailed'), severity: 'error' });
    }
  };

  return (
    <Stack spacing={1.5}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          p: 1.25,
          borderRadius: 2,
          backgroundColor: 'var(--mui-palette-action-hover)',
          border: '1px solid var(--mui-palette-divider)',
        }}
      >
        <Typography
          sx={{
            flex: 1,
            fontFamily: 'monospace',
            fontSize: 12,
            color: 'text.secondary',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={url}
        >
          {url || '(extension URL unavailable)'}
        </Typography>
        <Tooltip title={copied ? t('homepage.copied') : t('homepage.copy')}>
          <span>
            <IconButton size="small" onClick={onCopy} disabled={!url}>
              {copied ? <CheckIcon fontSize="small" /> : <ContentCopyIcon fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Chip
          icon={<CheckIcon sx={{ fontSize: 14 }} />}
          label={t('homepage.newTabActive')}
          size="small"
          color="success"
          variant="outlined"
        />
      </Stack>

      <Accordion disableGutters elevation={0} sx={{ backgroundColor: 'transparent', '&:before': { display: 'none' } }}>
        <AccordionSummary
          expandIcon={<ExpandMoreIcon />}
          sx={{ px: 0, minHeight: 36, '& .MuiAccordionSummary-content': { my: 0.5 } }}
        >
          <Stack direction="row" spacing={1} alignItems="center">
            <HomeIcon fontSize="small" sx={{ color: 'text.secondary' }} />
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
              {t('homepage.homeButtonTitle')}
            </Typography>
          </Stack>
        </AccordionSummary>
        <AccordionDetails sx={{ px: 0, pb: 1 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {t('homepage.homeButtonBody')}
          </Typography>
          <Button
            size="small"
            variant="outlined"
            startIcon={<LaunchIcon sx={{ fontSize: 14 }} />}
            onClick={() => chrome.tabs?.create?.({ url: 'chrome://settings/?search=home+button' })}
          >
            {t('homepage.openSettings')}
          </Button>
        </AccordionDetails>
      </Accordion>

      <Accordion disableGutters elevation={0} sx={{ backgroundColor: 'transparent', '&:before': { display: 'none' } }}>
        <AccordionSummary
          expandIcon={<ExpandMoreIcon />}
          sx={{ px: 0, minHeight: 36, '& .MuiAccordionSummary-content': { my: 0.5 } }}
        >
          <Stack direction="row" spacing={1} alignItems="center">
            <LaunchIcon fontSize="small" sx={{ color: 'text.secondary' }} />
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
              {t('homepage.startupTitle')}
            </Typography>
          </Stack>
        </AccordionSummary>
        <AccordionDetails sx={{ px: 0, pb: 1 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {t('homepage.startupBody')}
          </Typography>
          <Button
            size="small"
            variant="outlined"
            startIcon={<LaunchIcon sx={{ fontSize: 14 }} />}
            onClick={() => chrome.tabs?.create?.({ url: 'chrome://settings/onStartup' })}
          >
            {t('homepage.openStartupSettings')}
          </Button>
        </AccordionDetails>
      </Accordion>

      <Accordion
        disableGutters
        elevation={0}
        defaultExpanded
        sx={{ backgroundColor: 'transparent', '&:before': { display: 'none' } }}
      >
        <AccordionSummary
          expandIcon={<ExpandMoreIcon />}
          sx={{ px: 0, minHeight: 36, '& .MuiAccordionSummary-content': { my: 0.5 } }}
        >
          <Stack direction="row" spacing={1} alignItems="center">
            <KeyboardIcon fontSize="small" sx={{ color: 'text.secondary' }} />
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
              {t('homepage.shortcutTitle')}
            </Typography>
          </Stack>
        </AccordionSummary>
        <AccordionDetails sx={{ px: 0, pb: 1 }}>
          <Typography variant="body2" color="text.secondary">
            {t('homepage.shortcutBody')}
          </Typography>
        </AccordionDetails>
      </Accordion>
    </Stack>
  );
}
