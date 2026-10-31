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

// Streams a Blob through a (de)compressor without materializing the input
// as one array — the event log of a heavy user is large.
async function pipeBlob(blob: Blob, stream: CompressionStream | DecompressionStream): Promise<Blob> {
  return new Response(blob.stream().pipeThrough(stream)).blob();
}

export const gzipBlob = (b: Blob) => pipeBlob(b, new CompressionStream('gzip'));

async function crc32Blob(blob: Blob): Promise<number> {
  let crc = 0xffffffff;
  crc32(new Uint8Array(0)); // build the table
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (let i = 0; i < value.length; i++) crc = crcTable![(crc ^ value[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Entries may be Blobs (built from many small JSON chunks); the archive comes
// back as a Blob of header arrays + compressed bodies, so no single buffer
// ever holds the whole bundle.
export async function writeZip(
  entries: Array<{ name: string; data: Uint8Array | Blob }>,
  when = new Date(),
): Promise<Blob> {
  const dosTime = (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2);
  const dosDate = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const FLAGS = 0x0800; // UTF-8 names
  const enc = new TextEncoder();

  const items: Array<{ name: Uint8Array; method: number; body: Blob; size: number; crc: number }> = [];
  for (const e of entries) {
    const data = e.data instanceof Blob ? e.data : new Blob([e.data as BlobPart]);
    const deflated = await pipeBlob(data, new CompressionStream('deflate-raw'));
    // Tiny files can grow under DEFLATE; store those as-is.
    const store = deflated.size >= data.size;
    items.push({
      name: enc.encode(e.name),
      method: store ? 0 : 8,
      body: store ? data : deflated,
      size: data.size,
      crc: await crc32Blob(data),
    });
  }

  const parts: BlobPart[] = [];
  const offsets: number[] = [];
  let p = 0;
  for (const it of items) {
    offsets.push(p);
    const h = new Uint8Array(30 + it.name.length);
    w32(h, 0, SIG_LFH);
    w16(h, 4, 20);
    w16(h, 6, FLAGS);
    w16(h, 8, it.method);
    w16(h, 10, dosTime);
    w16(h, 12, dosDate);
    w32(h, 14, it.crc);
    w32(h, 18, it.body.size);
    w32(h, 22, it.size);
    w16(h, 26, it.name.length);
    w16(h, 28, 0);
    h.set(it.name, 30);
    parts.push(h, it.body);
    p += h.length + it.body.size;
  }
  const cdStart = p;
  let cdSize = 0;
  items.forEach((it, i) => {
    const c = new Uint8Array(46 + it.name.length);
    w32(c, 0, SIG_CDH);
    w16(c, 4, 20);
    w16(c, 6, 20);
    w16(c, 8, FLAGS);
    w16(c, 10, it.method);
    w16(c, 12, dosTime);
    w16(c, 14, dosDate);
    w32(c, 16, it.crc);
    w32(c, 20, it.body.size);
    w32(c, 24, it.size);
    w16(c, 28, it.name.length);
    // extra, comment, disk, internal attrs, external attrs: all zero
    w32(c, 42, offsets[i]);
    c.set(it.name, 46);
    parts.push(c);
    cdSize += c.length;
  });
  const eocd = new Uint8Array(22);
  w32(eocd, 0, SIG_EOCD);
  w16(eocd, 8, items.length);
  w16(eocd, 10, items.length);
  w32(eocd, 12, cdSize);
  w32(eocd, 16, cdStart);
  parts.push(eocd);
  return new Blob(parts, { type: 'application/zip' });
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
