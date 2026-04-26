// Build-time icon generator. Reads public/icons/icon.svg and emits
// 16/32/48/128 PNGs into the same directory so the manifest can reference
// them. Pure-WASM via @resvg/resvg-js so it works on every CI without a
// native toolchain.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = resolve(__dirname, '..', 'public', 'icons');
const sourcePath = join(iconsDir, 'icon.svg');
const sizes = [16, 32, 48, 128];

async function main() {
  if (!existsSync(sourcePath)) {
    console.error(`[icons] missing source ${sourcePath}`);
    process.exit(1);
  }
  await mkdir(iconsDir, { recursive: true });
  const svg = await readFile(sourcePath, 'utf8');

  for (const size of sizes) {
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: size },
      background: 'rgba(0, 0, 0, 0)',
    });
    const png = resvg.render().asPng();
    const out = join(iconsDir, `icon${size}.png`);
    await writeFile(out, png);
    console.log(`[icons] wrote ${out} (${png.length} bytes)`);
  }
}

await main();
