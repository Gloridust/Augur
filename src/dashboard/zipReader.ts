// Minimal ZIP reader — the read-side twin of src/ml/zip-writer.ts. Only
// supports STORE (method 0) entries, which is all our own debug-bundle
// export ever writes. Used to restore lost history by importing a debug
// bundle straight from the Settings dialog: the bundle carries the same
// tables as a DataDump (events/feedback/domains/…/kv as separate JSON
// files), so parsing the zip and reassembling the dump gives us a full
// merge-importable snapshot without asking users to unzip anything.
//
// Walks local-file-header records from offset 0 (our writer emits them
// back-to-back with no gaps). Stops at the central directory. Rejects
// DEFLATE entries loudly — a re-zipped bundle (e.g. user unzipped and
// re-compressed with Finder) is compressed, and silently returning garbage
// would corrupt an import.

import type { DataDump } from '../ml/data-ops';

const SIG_LFH = 0x04034b50;

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

export function readZipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  let off = 0;
  const dec = new TextDecoder();
  while (off + 30 <= bytes.length && u32(bytes, off) === SIG_LFH) {
    const method = u16(bytes, off + 8);
    const compSize = u32(bytes, off + 18);
    const nameLen = u16(bytes, off + 26);
    const extraLen = u16(bytes, off + 28);
    const name = dec.decode(bytes.subarray(off + 30, off + 30 + nameLen));
    const dataStart = off + 30 + nameLen + extraLen;
    if (method !== 0) {
      throw new Error(`zip entry "${name}" is compressed (method ${method}) — not an original Augur bundle`);
    }
    entries.set(name, bytes.subarray(dataStart, dataStart + compSize));
    off = dataStart + compSize;
  }
  return entries;
}

export function isZipFile(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && u32(bytes, 0) === SIG_LFH;
}

// Reassemble a DataDump from a debug-bundle zip. Returns null when the zip
// doesn't look like an Augur bundle (missing the mandatory tables).
export function debugBundleToDump(bytes: Uint8Array): DataDump | null {
  const entries = readZipEntries(bytes);
  const dec = new TextDecoder();
  const json = <T>(name: string): T | undefined => {
    const raw = entries.get(name);
    if (!raw) return undefined;
    try {
      return JSON.parse(dec.decode(raw)) as T;
    } catch {
      return undefined;
    }
  };

  const events = json<unknown[]>('events.json');
  const kv = json<unknown[]>('kv.json');
  if (!Array.isArray(events) || !Array.isArray(kv)) return null;

  const manifest = json<{ exportedAt?: number }>('MANIFEST.json');
  return {
    schemaVersion: 4,
    exportedAt: manifest?.exportedAt ?? Date.now(),
    events,
    feedback: json<unknown[]>('feedback.json') ?? [],
    domains: json<unknown[]>('domains.json') ?? [],
    cooccurrence: json<unknown[]>('cooccurrence.json') ?? [],
    stash: json<unknown[]>('stash.json') ?? [],
    workspaces: json<unknown[]>('workspaces.json') ?? [],
    pins: json<unknown[]>('pins.json') ?? [],
    kv,
  };
}
