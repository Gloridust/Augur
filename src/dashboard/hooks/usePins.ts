import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, extractDomain } from '../../shared/db';
import type { PinnedItem } from '../../shared/types';
import { isCooldownActive, useSmartPinSort } from './useSmartPinSort';
import { rerankPinsViaModel } from '../api/recommendations';

export interface AddPinInput {
  url: string;
  title: string;
  favIconUrl?: string;
}

function pinKeyFromUrl(url: string): string {
  return url;
}

export interface UsePinsResult {
  pins: PinnedItem[];
  smartSortApplied: boolean;
  add: (input: AddPinInput) => Promise<void>;
  remove: (key: string) => Promise<void>;
  reorder: (orderedKeys: string[]) => Promise<void>;
  isPinned: (url: string) => boolean;
}

export function usePins(): UsePinsResult {
  const rawPins = useLiveQuery(
    () => db.pins.orderBy('manualOrder').toArray(),
    [],
    [] as PinnedItem[],
  );
  const [smartSortEnabled] = useSmartPinSort();
  // Score map fetched from the SW model. Refreshed when the pin set changes
  // or when the user toggles smart sort on (and isn't in cooldown).
  const [modelScores, setModelScores] = useState<Map<string, number>>(new Map());

  // Whether smart sort is currently active. Both flags must be true.
  const cooldownNow = isCooldownActive();
  const smartActive = smartSortEnabled && !cooldownNow;

  // Refresh model scores whenever pins change OR smart sort flips on. We
  // also rerun every time the active tab changes so context-sensitive
  // features (focused domain, session context) stay current.
  useEffect(() => {
    if (!smartActive || rawPins.length === 0) {
      setModelScores(new Map());
      return;
    }
    let cancelled = false;
    const fetchScores = async () => {
      const rows = await rerankPinsViaModel(
        rawPins.map((p) => ({ url: p.url, pinnedAt: p.pinnedAt })),
      );
      if (cancelled) return;
      const map = new Map<string, number>();
      for (const r of rows) map.set(r.url, r.score);
      setModelScores(map);
    };
    void fetchScores();

    if (typeof chrome !== 'undefined' && chrome?.tabs?.onActivated) {
      let pending = false;
      const trigger = () => {
        if (pending) return;
        pending = true;
        window.setTimeout(() => {
          pending = false;
          void fetchScores();
        }, 800);
      };
      chrome.tabs.onActivated.addListener(trigger);
      chrome.tabs.onUpdated.addListener(trigger);
      return () => {
        cancelled = true;
        chrome.tabs.onActivated.removeListener(trigger);
        chrome.tabs.onUpdated.removeListener(trigger);
      };
    }
    return () => {
      cancelled = true;
    };
  }, [rawPins, smartActive]);

  const sorted = useMemo<{ pins: PinnedItem[]; smart: boolean }>(() => {
    if (rawPins.length === 0) return { pins: [], smart: false };
    if (!smartActive) {
      // Manual order: smaller manualOrder first, then most-recently pinned.
      return {
        pins: [...rawPins].sort(
          (a, b) => a.manualOrder - b.manualOrder || b.pinnedAt - a.pinnedAt,
        ),
        smart: false,
      };
    }
    // Model-driven order. Pins without a fetched score yet (e.g. first
    // render) fall to the bottom so we don't appear to remove them.
    return {
      pins: [...rawPins].sort((a, b) => {
        const sa = modelScores.get(a.url) ?? -Infinity;
        const sb = modelScores.get(b.url) ?? -Infinity;
        return sb - sa;
      }),
      smart: true,
    };
  }, [rawPins, modelScores, smartActive]);

  const isPinned = useCallback(
    (url: string) => rawPins.some((p) => p.url === url),
    [rawPins],
  );

  const add = useCallback(async (input: AddPinInput) => {
    const key = pinKeyFromUrl(input.url);
    const existing = await db.pins.where('key').equals(key).first();
    if (existing) {
      await db.pins.update(existing.id!, {
        manualOrder: -Date.now(),
        pinnedAt: Date.now(),
      });
      return;
    }
    await db.pins.add({
      key,
      url: input.url,
      title: input.title || input.url,
      domain: extractDomain(input.url),
      favIconUrl: input.favIconUrl,
      pinnedAt: Date.now(),
      manualOrder: -Date.now(),
    });
  }, []);

  const remove = useCallback(async (key: string) => {
    const existing = await db.pins.where('key').equals(key).first();
    if (existing?.id !== undefined) await db.pins.delete(existing.id);
  }, []);

  const reorder = useCallback(async (orderedKeys: string[]) => {
    const all = await db.pins.toArray();
    const byKey = new Map(all.map((p) => [p.key, p]));
    const updates = orderedKeys
      .map((key, idx) => {
        const p = byKey.get(key);
        return p?.id !== undefined ? { id: p.id, manualOrder: idx } : null;
      })
      .filter((x): x is { id: number; manualOrder: number } => !!x);
    await db.transaction('rw', db.pins, async () => {
      for (const u of updates) await db.pins.update(u.id, { manualOrder: u.manualOrder });
    });
  }, []);

  return {
    pins: sorted.pins,
    smartSortApplied: sorted.smart,
    add,
    remove,
    reorder,
    isPinned,
  };
}
