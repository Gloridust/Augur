// Minimal ZIP writer (STORE method, no compression). The single use case
// is the debug-bundle export: combine ~7 JSON files into one downloadable
// archive. Adding a real compression library (fflate, jszip) for this
// would be ~10KB of dependency for a feature used once in a blue moon —
// we'd rather hand-write the ~80 lines of ZIP record format.
//
// References:
//   - PKWARE APPNOTE.TXT (ZIP file format spec)
//   - We implement only "store" mode (no DEFLATE), which means each file's
//     raw bytes go in unchanged. Modern OSes / browsers handle uncompressed
//     ZIPs fine; the bundle is text-heavy JSON and the user can re-compress
//     it themselves if size matters.
//
// Output: Uint8Array containing the full ZIP byte stream. Caller is
// responsible for converting to Blob / base64 / file save.

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

// CRC-32 (IEEE 802.3 polynomial). The ZIP format requires a CRC for each
// file even in STORE mode. Standard table-driven implementation.
let crc32Table: Uint32Array | null = null;
function getCrc32Table(): Uint32Array {
  if (crc32Table) return crc32Table;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  crc32Table = table;
  return table;
}

function crc32(bytes: Uint8Array): number {
  const table = getCrc32Table();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function writeUint32LE(out: Uint8Array, offset: number, v: number): void {
  out[offset] = v & 0xff;
  out[offset + 1] = (v >>> 8) & 0xff;
  out[offset + 2] = (v >>> 16) & 0xff;
  out[offset + 3] = (v >>> 24) & 0xff;
}
function writeUint16LE(out: Uint8Array, offset: number, v: number): void {
  out[offset] = v & 0xff;
  out[offset + 1] = (v >>> 8) & 0xff;
}

// DOS time/date — ZIP stores mtime in MS-DOS format (no timezone, 2-second
// resolution). We just record the export time.
function dosDateTime(d: Date): { date: number; time: number } {
  const time =
    (d.getHours() << 11) |
    (d.getMinutes() << 5) |
    Math.floor(d.getSeconds() / 2);
  const date =
    ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { date, time };
}

export function writeZip(entries: ZipEntry[]): Uint8Array {
  const now = new Date();
  const { date: dosDate, time: dosTime } = dosDateTime(now);
  const SIG_LFH = 0x04034b50;
  const SIG_CDH = 0x02014b50;
  const SIG_EOCD = 0x06054b50;
  const VERSION = 20;
  const FLAGS = 0x0800; // bit 11: filename is UTF-8

  // Pass 1: compute total size + per-entry metadata.
  const meta = entries.map((e) => {
    const nameBytes = utf8(e.name);
    return {
      ...e,
      nameBytes,
      crc: crc32(e.data),
      lfhSize: 30 + nameBytes.length + e.data.length,
      cdhSize: 46 + nameBytes.length,
    };
  });
  const lfhTotal = meta.reduce((s, m) => s + m.lfhSize, 0);
  const cdhTotal = meta.reduce((s, m) => s + m.cdhSize, 0);
  const eocdSize = 22;
  const total = lfhTotal + cdhTotal + eocdSize;

  const out = new Uint8Array(total);
  let off = 0;
  const offsets: number[] = [];

  // Local file headers + raw data.
  for (const m of meta) {
    offsets.push(off);
    writeUint32LE(out, off, SIG_LFH);
    writeUint16LE(out, off + 4, VERSION);
    writeUint16LE(out, off + 6, FLAGS);
    writeUint16LE(out, off + 8, 0); // method = STORE
    writeUint16LE(out, off + 10, dosTime);
    writeUint16LE(out, off + 12, dosDate);
    writeUint32LE(out, off + 14, m.crc);
    writeUint32LE(out, off + 18, m.data.length); // compressed size
    writeUint32LE(out, off + 22, m.data.length); // uncompressed size
    writeUint16LE(out, off + 26, m.nameBytes.length);
    writeUint16LE(out, off + 28, 0); // extra field length
    out.set(m.nameBytes, off + 30);
    out.set(m.data, off + 30 + m.nameBytes.length);
    off += m.lfhSize;
  }

  // Central directory.
  const cdStart = off;
  for (let i = 0; i < meta.length; i++) {
    const m = meta[i];
    writeUint32LE(out, off, SIG_CDH);
    writeUint16LE(out, off + 4, VERSION); // version made by
    writeUint16LE(out, off + 6, VERSION); // version to extract
    writeUint16LE(out, off + 8, FLAGS);
    writeUint16LE(out, off + 10, 0); // method
    writeUint16LE(out, off + 12, dosTime);
    writeUint16LE(out, off + 14, dosDate);
    writeUint32LE(out, off + 16, m.crc);
    writeUint32LE(out, off + 20, m.data.length);
    writeUint32LE(out, off + 24, m.data.length);
    writeUint16LE(out, off + 28, m.nameBytes.length);
    writeUint16LE(out, off + 30, 0); // extra field
    writeUint16LE(out, off + 32, 0); // comment length
    writeUint16LE(out, off + 34, 0); // disk number
    writeUint16LE(out, off + 36, 0); // internal attrs
    writeUint32LE(out, off + 38, 0); // external attrs
    writeUint32LE(out, off + 42, offsets[i]); // local header offset
    out.set(m.nameBytes, off + 46);
    off += m.cdhSize;
  }

  // End of central directory.
  writeUint32LE(out, off, SIG_EOCD);
  writeUint16LE(out, off + 4, 0); // disk number
  writeUint16LE(out, off + 6, 0); // disk with CD start
  writeUint16LE(out, off + 8, meta.length); // CD entries on this disk
  writeUint16LE(out, off + 10, meta.length); // total CD entries
  writeUint32LE(out, off + 12, cdhTotal); // CD size
  writeUint32LE(out, off + 16, cdStart); // CD offset
  writeUint16LE(out, off + 20, 0); // comment length

  return out;
}

// Convert binary to base64 — used to hand a Uint8Array across the RPC
// boundary. chrome.runtime messages serialize via JSON, so we need a
// string transport. Done manually to avoid loading the typed-array's
// toString() which doesn't do what you'd expect.
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000; // avoid call-stack overflow on huge arrays
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  // btoa is available in service workers and dashboard contexts.
  return btoa(binary);
}
