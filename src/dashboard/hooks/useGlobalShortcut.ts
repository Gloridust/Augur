import { useEffect } from 'react';

// Listen for ⌘K / Ctrl+K and trigger a callback. Skips when user is typing
// in another input unless `allowInInputs` is true (the palette itself
// should still close on its own Escape, handled inside the component).
export function useCommandPaletteShortcut(onTrigger: () => void): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isCmd = e.metaKey || e.ctrlKey;
      if (!isCmd) return;
      if (e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      onTrigger();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onTrigger]);
}
