import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Avatar,
  Box,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import type { PinnedItem } from '../../shared/types';
import { usePins } from '../hooks/usePins';
import { markManualReorder } from '../hooks/useSmartPinSort';
import { openUrlViaSw } from '../api/recommendations';

function favicon(item: PinnedItem): string | undefined {
  if (item.favIconUrl) return item.favIconUrl;
  try {
    return `https://www.google.com/s2/favicons?sz=64&domain=${new URL(item.url).hostname}`;
  } catch {
    return undefined;
  }
}

// One pinned site, rendered as a draggable pill.
function PinChip({
  item,
  onOpen,
  onUnpin,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragging,
  isDropTarget,
}: {
  item: PinnedItem;
  onOpen: () => void;
  onUnpin: () => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  isDragging: boolean;
  isDropTarget: boolean;
}) {
  return (
    <Box
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.key);
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        onDragOver(e);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      sx={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        height: 34,
        pl: 0.75,
        pr: 0.5,
        borderRadius: 999,
        backgroundColor: 'var(--mui-palette-background-paper)',
        border: '1px solid var(--mui-palette-divider)',
        cursor: 'pointer',
        opacity: isDragging ? 0.4 : 1,
        // Subtle drop indicator on the leading edge of the target chip.
        boxShadow: isDropTarget
          ? 'inset 3px 0 0 var(--mui-palette-primary-main)'
          : 'none',
        transition: 'background-color 150ms ease, border-color 150ms ease',
        '&:hover': {
          backgroundColor: 'var(--mui-palette-action-hover)',
          borderColor: 'rgba(31, 30, 27, 0.18)',
        },
        '& .pin-close': {
          opacity: 0,
          transition: 'opacity 120ms ease',
        },
        '&:hover .pin-close': { opacity: 1 },
      }}
      title={item.title || item.url}
    >
      <Avatar
        src={favicon(item)}
        variant="rounded"
        sx={{ width: 18, height: 18, bgcolor: 'transparent' }}
      />
      <Typography
        sx={{
          fontSize: 13,
          fontWeight: 500,
          maxWidth: 160,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          userSelect: 'none',
        }}
      >
        {item.title || item.domain}
      </Typography>
      <IconButton
        size="small"
        className="pin-close"
        onClick={(e) => {
          e.stopPropagation();
          onUnpin();
        }}
        sx={{ p: 0.25, ml: 0.25 }}
      >
        <CloseIcon sx={{ fontSize: 14 }} />
      </IconButton>
    </Box>
  );
}

export function PinsRow() {
  const { t } = useTranslation();
  const { pins, smartSortApplied, remove, reorder } = usePins();
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  if (pins.length === 0) return null;

  const onDrop = (targetKey: string) => {
    if (!draggingKey || draggingKey === targetKey) {
      setDraggingKey(null);
      setDropTargetKey(null);
      return;
    }
    // Build new key order: remove dragged, insert before target.
    const ordered = pins.map((p) => p.key);
    const without = ordered.filter((k) => k !== draggingKey);
    const targetIdx = without.indexOf(targetKey);
    if (targetIdx < 0) {
      setDraggingKey(null);
      setDropTargetKey(null);
      return;
    }
    const next = [
      ...without.slice(0, targetIdx),
      draggingKey,
      ...without.slice(targetIdx),
    ];
    void reorder(next);
    markManualReorder();
    setDraggingKey(null);
    setDropTargetKey(null);
  };

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          mb: 0.75,
          minHeight: 22,
          color: 'text.secondary',
        }}
      >
        <Typography variant="caption" sx={{ letterSpacing: '0.04em', fontWeight: 500 }}>
          {t('pins.heading')}
        </Typography>
        {smartSortApplied && (
          <Tooltip title={t('pins.smartSortHint')}>
            <Stack direction="row" alignItems="center" spacing={0.25} sx={{ color: 'primary.main' }}>
              <AutoAwesomeIcon sx={{ fontSize: 12 }} />
              <Typography variant="caption" sx={{ fontSize: 11 }}>
                {t('pins.smartSortBadge')}
              </Typography>
            </Stack>
          </Tooltip>
        )}
      </Box>

      <Box
        ref={scrollerRef}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          overflowX: 'auto',
          overflowY: 'visible',
          pb: 0.5,
          // Hide the horizontal scrollbar but keep wheel/touch scroll working.
          '&::-webkit-scrollbar': { height: 6 },
          '&::-webkit-scrollbar-thumb': {
            background: 'rgba(31, 30, 27, 0.16)',
            borderRadius: 999,
          },
        }}
        onDragOver={(e) => e.preventDefault()}
      >
        {pins.map((p) => (
          <PinChip
            key={p.key}
            item={p}
            isDragging={draggingKey === p.key}
            isDropTarget={dropTargetKey === p.key && draggingKey !== null && draggingKey !== p.key}
            onOpen={() => void openUrlViaSw(p.url)}
            onUnpin={() => void remove(p.key)}
            onDragStart={() => setDraggingKey(p.key)}
            onDragOver={() => setDropTargetKey(p.key)}
            onDrop={() => onDrop(p.key)}
            onDragEnd={() => {
              setDraggingKey(null);
              setDropTargetKey(null);
            }}
          />
        ))}
      </Box>
    </Box>
  );
}
