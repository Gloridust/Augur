// Build a Chrome Web Store-ready zip of dist/.
//
// Run via: `npm run package`. Output: chromehomepage-<version>.zip in repo root.

import { execSync } from 'node:child_process';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const distDir = resolve(repoRoot, 'dist');

// Folders inside `public/` that exist for repo-level docs (e.g. README
// screenshots) but should NOT travel into the built extension bundle. Vite
// copies the whole publicDir into dist by default; we strip these
// post-build so the unpacked extension and the zip both stay lean.
const NON_EXTENSION_PUBLIC_DIRS = ['demo'];

async function main() {
  if (!existsSync(distDir)) {
    console.error('[package] dist/ does not exist — run `npm run build` first.');
    process.exit(1);
  }

  for (const name of NON_EXTENSION_PUBLIC_DIRS) {
    const path = resolve(distDir, name);
    if (existsSync(path)) {
      await rm(path, { recursive: true, force: true });
      console.log(`[package] stripped dist/${name}/ from extension bundle`);
    }
  }

  const pkg = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8'));
  const out = resolve(repoRoot, `${pkg.name}-${pkg.version}.zip`);
  if (existsSync(out)) unlinkSync(out);

  // -X: don't store extra file attributes; -r: recursive; exclude source maps
  // and Vite's internal build manifest.
  execSync(
    `cd dist && zip -rX "${out}" . -x "*.map" -x ".vite/*"`,
    { stdio: 'inherit' },
  );
  const { size } = statSync(out);
  console.log(`[package] wrote ${out} (${(size / 1024).toFixed(1)} KB)`);
}

await main();
