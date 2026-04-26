import { useEffect, useState } from 'react';
import { Alert, Snackbar } from '@mui/material';

type ToastSeverity = 'success' | 'info' | 'warning' | 'error';

export interface ToastEventDetail {
  message: string;
  severity?: ToastSeverity;
  durationMs?: number;
}

const EVT = 'augur:toast';

export function toast(detail: ToastEventDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ToastEventDetail>(EVT, { detail }));
}

export function Toaster() {
  const [current, setCurrent] = useState<ToastEventDetail | null>(null);
  const [queue, setQueue] = useState<ToastEventDetail[]>([]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ToastEventDetail>).detail;
      setQueue((q) => [...q, detail]);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason;
      const msg =
        reason instanceof Error
          ? reason.message
          : typeof reason === 'string'
            ? reason
            : 'Unexpected error';
      setQueue((q) => [...q, { message: msg, severity: 'error', durationMs: 6000 }]);
    };
    window.addEventListener(EVT, handler);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener(EVT, handler);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  useEffect(() => {
    if (current === null && queue.length > 0) {
      setCurrent(queue[0]);
      setQueue((q) => q.slice(1));
    }
  }, [current, queue]);

  const onClose = () => setCurrent(null);

  return (
    <Snackbar
      open={!!current}
      autoHideDuration={current?.durationMs ?? 3500}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      {current ? (
        <Alert
          severity={current.severity ?? 'info'}
          variant="filled"
          onClose={onClose}
          sx={{ borderRadius: 999, px: 2 }}
        >
          {current.message}
        </Alert>
      ) : undefined}
    </Snackbar>
  );
}
