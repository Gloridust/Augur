// Minimal ZIP read/write for Augur's own bundles — no dependency.
//
// Writer: entries are DEFLATE-compressed with the platform CompressionStream
// ('deflate-raw', the exact payload format ZIP method 8 expects). Event-log
// JSON compresses ~10×, so a bundle that used to be 60 MB is now ~6 MB.
//
// Reader: walks the CENTRAL DIRECTORY (not local headers), so it also opens
// archives re-zipped by Finder/Explorer, which put sizes in trailing data
// descriptors and zero them in the local header. Handles STORE (0) and
// DEFLATE (8).
//
// References: PKWARE APPNOTE.TXT.

export interface ZipInput {
  name: string;
  data: Uint8Array;
}

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export const deflateRaw = (b: Uint8Array) => pipe(b, new CompressionStream('deflate-raw'));
export const inflateRaw = (b: Uint8Array) => pipe(b, new DecompressionStream('deflate-raw'));
export const gzip = (b: Uint8Array) => pipe(b, new CompressionStream('gzip'));
export const gunzip = (b: Uint8Array) => pipe(b, new DecompressionStream('gzip'));

export function isGzip(b: Uint8Array): boolean {
  return b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
}

const SIG_LFH = 0x04034b50;
const SIG_CDH = 0x02014b50;
const SIG_EOCD = 0x06054b50;

function w16(o: Uint8Array, p: number, v: number) {
  o[p] = v & 0xff;
  o[p + 1] = (v >>> 8) & 0xff;
}
function w32(o: Uint8Array, p: number, v: number) {
  w16(o, p, v);
  w16(o, p + 2, v >>> 16);
}
function r16(b: Uint8Array, p: number): number {
  return b[p] | (b[p + 1] << 8);
}
function r32(b: Uint8Array, p: number): number {
  return (r16(b, p) | (r16(b, p + 2) << 16)) >>> 0;
}

export async function writeZip(entries: ZipInput[], when = new Date()): Promise<Uint8Array> {
  const dosTime = (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2);
  const dosDate = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const FLAGS = 0x0800; // UTF-8 names
  const enc = new TextEncoder();

  const items = await Promise.all(
    entries.map(async (e) => {
      const deflated = await deflateRaw(e.data);
      // Tiny files can grow under DEFLATE; store those as-is.
      const store = deflated.length >= e.data.length;
      return {
        name: enc.encode(e.name),
        method: store ? 0 : 8,
        body: store ? e.data : deflated,
        size: e.data.length,
        crc: crc32(e.data),
      };
    }),
  );

  const total =
    items.reduce((s, it) => s + 30 + it.name.length + it.body.length + 46 + it.name.length, 0) + 22;
  const out = new Uint8Array(total);
  const offsets: number[] = [];
  let p = 0;
  for (const it of items) {
    offsets.push(p);
    w32(out, p, SIG_LFH);
    w16(out, p + 4, 20);
    w16(out, p + 6, FLAGS);
    w16(out, p + 8, it.method);
    w16(out, p + 10, dosTime);
    w16(out, p + 12, dosDate);
    w32(out, p + 14, it.crc);
    w32(out, p + 18, it.body.length);
    w32(out, p + 22, it.size);
    w16(out, p + 26, it.name.length);
    w16(out, p + 28, 0);
    out.set(it.name, p + 30);
    out.set(it.body, p + 30 + it.name.length);
    p += 30 + it.name.length + it.body.length;
  }
  const cdStart = p;
  items.forEach((it, i) => {
    w32(out, p, SIG_CDH);
    w16(out, p + 4, 20);
    w16(out, p + 6, 20);
    w16(out, p + 8, FLAGS);
    w16(out, p + 10, it.method);
    w16(out, p + 12, dosTime);
    w16(out, p + 14, dosDate);
    w32(out, p + 16, it.crc);
    w32(out, p + 20, it.body.length);
    w32(out, p + 24, it.size);
    w16(out, p + 28, it.name.length);
    // extra, comment, disk, internal attrs, external attrs: all zero
    w32(out, p + 42, offsets[i]);
    out.set(it.name, p + 46);
    p += 46 + it.name.length;
  });
  w32(out, p, SIG_EOCD);
  w16(out, p + 8, items.length);
  w16(out, p + 10, items.length);
  w32(out, p + 12, p - cdStart);
  w32(out, p + 16, cdStart);
  return out;
}

export function isZip(b: Uint8Array): boolean {
  return b.length >= 4 && r32(b, 0) === SIG_LFH;
}

export async function readZip(b: Uint8Array): Promise<Map<string, Uint8Array>> {
  // EOCD is the last 22 bytes plus an optional comment of up to 64 KiB.
  let eocd = -1;
  for (let p = b.length - 22; p >= Math.max(0, b.length - 22 - 0xffff); p--) {
    if (r32(b, p) === SIG_EOCD) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = r16(b, eocd + 10);
  let p = r32(b, eocd + 16);
  const dec = new TextDecoder();
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (r32(b, p) !== SIG_CDH) throw new Error('corrupt zip central directory');
    const method = r16(b, p + 10);
    const compSize = r32(b, p + 20);
    const nameLen = r16(b, p + 28);
    const extraLen = r16(b, p + 30);
    const commentLen = r16(b, p + 32);
    const lfh = r32(b, p + 42);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // directory entry
    const start = lfh + 30 + r16(b, lfh + 26) + r16(b, lfh + 28);
    const body = b.subarray(start, start + compSize);
    if (method === 0) out.set(name, body);
    else if (method === 8) out.set(name, await inflateRaw(body));
    else throw new Error(`zip entry "${name}" uses unsupported method ${method}`);
  }
  return out;
}
