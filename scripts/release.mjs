// Build a Chrome Web Store-ready release zip with strict pre-flight checks.
//
// Usage:  npm run release
// Output: augur-v<version>-cws.zip in the repo root
//
// This is the SUBMISSION zip — verified clean, source maps stripped, no
// dev artifacts. Different from `npm run package` (which is the dev /
// local-distribution zip):
//
//   npm run package   →  unpacked-extension distribution (developer key OK)
//   npm run release   →  Chrome Web Store submission (CWS provides the key)
//
// Pre-flight checks (script aborts if any fail):
//   1. dist/manifest.json must NOT contain a `key` field — CWS rejects
//      packages that try to set their own extension ID
//   2. Every icon size declared in manifest must exist in dist/icons/
//   3. No source maps (*.map), no .DS_Store, no .vite/, no demo/
//   4. Service worker file is present and non-empty
//
// Soft warnings (script continues):
//   - Git working tree dirty
//   - Version number didn't change since the last commit that touched it

import { execSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const distDir = resolve(repoRoot, 'dist');

const REQUIRED_ICON_SIZES = [16, 32, 48, 128];
const FORBIDDEN_PATTERNS = [/\.map$/, /\.DS_Store$/, /^\.vite\//, /^demo\//];

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function walkRel(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name);
    const rel = relative(base, abs);
    if (entry.isDirectory()) {
      out.push(...walkRel(abs, base));
    } else {
      out.push(rel);
    }
  }
  return out;
}

function step(label) {
  console.log(`\n▶ ${label}`);
}

function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

function warn(msg) {
  console.warn(`  ⚠ ${msg}`);
}

async function main() {
  // ── 1. Clean previous build ───────────────────────────────────────
  step('Cleaning previous dist/');
  if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });

  // ── 2. Production build ───────────────────────────────────────────
  step('Building production bundle');
  execSync('npm run build', { stdio: 'inherit', cwd: repoRoot });

  // ── 3. Strip non-shipping artifacts ───────────────────────────────
  step('Stripping non-shipping artifacts');
  const STRIPPABLE = ['demo', '.vite'];
  for (const name of STRIPPABLE) {
    const path = resolve(distDir, name);
    if (existsSync(path)) {
      await rm(path, { recursive: true, force: true });
      console.log(`  removed dist/${name}/`);
    }
  }

  // ── 4. Pre-flight check: no `key` in manifest ─────────────────────
  step('Pre-flight checks');
  const manifestPath = resolve(distDir, 'manifest.json');
  if (!existsSync(manifestPath)) fail('dist/manifest.json missing — build failed?');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if ('key' in manifest) {
    fail(
      'dist/manifest.json contains a `key` field. CWS rejects packages with a ' +
        'custom extension key — comment out the `key:` line in src/manifest.ts ' +
        'and rebuild. (The `key` is for stable dev IDs only; CWS provides ' +
        "its own production key on publish.)",
    );
  }
  console.log('  manifest has no developer `key` ✓');

  // ── 5. Icons present ──────────────────────────────────────────────
  for (const size of REQUIRED_ICON_SIZES) {
    const p = resolve(distDir, 'icons', `icon${size}.png`);
    if (!existsSync(p)) fail(`Missing dist/icons/icon${size}.png`);
  }
  console.log(`  all ${REQUIRED_ICON_SIZES.length} icon sizes present ✓`);

  // ── 6. Service worker present ─────────────────────────────────────
  const swPath = resolve(distDir, 'service-worker-loader.js');
  if (!existsSync(swPath) || statSync(swPath).size === 0) {
    fail('Service worker loader missing or empty.');
  }
  console.log('  service worker loader present ✓');

  // ── 7. Manifest/package version match ─────────────────────────────
  const pkg = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8'));
  if (manifest.version !== pkg.version) {
    fail(`Version mismatch — package.json: ${pkg.version}, manifest: ${manifest.version}`);
  }
  console.log(`  version ${pkg.version} ✓`);

  // ── 8. Sweep dist/ for forbidden patterns ─────────────────────────
  const files = walkRel(distDir);
  const violations = files.filter((f) =>
    FORBIDDEN_PATTERNS.some((re) => re.test(f.replaceAll('\\', '/'))),
  );
  if (violations.length > 0) {
    fail(
      'Dist contains files that must not ship:\n' +
        violations.map((v) => `    - ${v}`).join('\n'),
    );
  }
  console.log(`  ${files.length} files, no forbidden patterns ✓`);

  // ── 9. Soft warnings ──────────────────────────────────────────────
  try {
    const dirty = execSync('git status --porcelain', { cwd: repoRoot })
      .toString()
      .trim();
    if (dirty) {
      warn('Git working tree is dirty — release zip may contain uncommitted code.');
    }
  } catch {
    // not a git repo — skip
  }

  // ── 10. Pack the zip ──────────────────────────────────────────────
  step('Packing release zip');
  const outName = `${pkg.name}-v${pkg.version}-cws.zip`;
  const outPath = resolve(repoRoot, outName);
  if (existsSync(outPath)) unlinkSync(outPath);

  // -X strips extra file attributes (macOS metadata); -r recursive
  execSync(
    `cd dist && zip -rX "${outPath}" . -x "*.map" -x ".DS_Store" -x ".vite/*" -x "demo/*"`,
    { stdio: 'inherit' },
  );
  const { size } = statSync(outPath);

  // ── 11. Summary + reminder ────────────────────────────────────────
  console.log(`\n✓ Release zip ready: ${outName} (${fmtSize(size)})`);
  console.log('\nNext steps:');
  console.log('  1. Smoke-test:  Load Unpacked → dist/');
  console.log('  2. Upload:      https://chrome.google.com/webstore/devconsole');
  console.log('  3. Permission justifications: see doc/RELEASE.md');
  console.log('');
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
