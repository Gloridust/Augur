// Race-free lazy singleton. Caches the *promise*, not the resolved value, so
// concurrent first callers share one load instead of each loading a private
// copy and the last save winning (which silently dropped training steps after
// every service-worker restart). A failed load is not cached.
export function lazy<T>(load: () => Promise<T>): { get(): Promise<T>; reset(): void } {
  let p: Promise<T> | null = null;
  return {
    get() {
      p ??= load().catch((err) => {
        p = null;
        throw err;
      });
      return p;
    },
    reset() {
      p = null;
    },
  };
}
