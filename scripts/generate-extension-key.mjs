// Generate a stable extension `key` for manifest.json.
//
// Why: when you load an unpacked extension into Chrome, the extension ID is
// derived from one of two sources, IN ORDER:
//   1. The `key` field in manifest.json (a base64-encoded RSA-2048 public key)
//   2. The install path (if no `key` is present)
//
// Without a `key`, every time you load the extension from a DIFFERENT path
// — or every time you remove + reload — Chrome assigns a NEW extension ID,
// and the new ID gets a fresh IndexedDB. Your events, model weights,
// workspaces, pins — everything — appear to be wiped, even though the data
// is still there under the OLD ID's storage.
//
// With a stable `key`, the extension ID is the same across all dev paths,
// so IndexedDB persists across rebuilds / re-installs. Chrome Web Store
// publishing uses its own production key and ignores this field, so adding
// it is safe for both dev and release.
//
// Run once: `node scripts/generate-extension-key.mjs`
// Paste the printed string into `src/manifest.ts` as the `key` field:
//
//     export default defineManifest({
//       manifest_version: 3,
//       name: '__MSG_extName__',
//       version: '0.1.0',
//       key: '<paste base64 string here>',
//       ...
//     });
//
// SAFETY: this key is for local development data continuity only. The
// corresponding private key is generated and immediately discarded — it's
// NOT written anywhere — so this can't be used to spoof or hijack your
// Chrome Web Store listing.

import { generateKeyPairSync } from 'node:crypto';

const { publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'der' },
});

const base64 = publicKey.toString('base64');

console.log('--- Augur dev extension key ---');
console.log();
console.log('Copy this string and paste it into src/manifest.ts as the `key` field:');
console.log();
console.log(base64);
console.log();
console.log('Then rebuild + reload the extension. From now on, the extension ID');
console.log('will be stable across rebuilds, and your IndexedDB data will');
console.log('persist when you reload the extension.');
