import { useCallback, useEffect, useState } from 'react';
import { fetchSummary } from '../api/recommendations';
import type { DataSummary } from '../../shared/types';
import { visiblePoll } from '../liveRefresh';

export function useDataSummary(): {
  summary: DataSummary | null;
  refresh: () => void;
  loading: boolean;
} {
  const [summary, setSummary] = useState<DataSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchSummary();
      setSummary(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return visiblePoll(() => void refresh(), 60_000);
  }, [refresh]);

  return { summary, refresh, loading };
}
