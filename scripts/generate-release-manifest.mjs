// Builds manifest.json for a GitHub release from its uploaded assets.
// Usage: node scripts/generate-release-manifest.mjs <tag> [outFile=manifest.json]
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RELEASE_URL = 'https://github.com/codemie-ai/codemie-connect/releases/download';

// First matching pattern in list order wins (deterministic tie-break).
const PLATFORMS = {
  'darwin-aarch64': [/^CodeMie-Connect-.+-aarch64\.dmg$/],
  'windows-x86_64': [/^CodeMie-Connect-.+-x64-setup\.exe$/, /^CodeMie-Connect-.+-windows-amd64\.exe$/],
};

export function buildManifest({ tag, assetNames }) {
  const platforms = {};
  for (const [key, patterns] of Object.entries(PLATFORMS)) {
    for (const pattern of patterns) {
      const name = assetNames.find((n) => pattern.test(n));
      if (name) {
        platforms[key] = { url: `${RELEASE_URL}/${tag}/${name}` };
        break;
      }
    }
  }
  return { version: tag.replace(/^v/, ''), platforms };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag, outFile = 'manifest.json'] = process.argv.slice(2);
  if (!tag) {
    console.error('usage: generate-release-manifest.mjs <tag> [outFile]');
    process.exit(2);
  }
  const { assets } = JSON.parse(execFileSync('gh', ['release', 'view', tag, '--json', 'assets'], { encoding: 'utf8' }));
  const manifest = buildManifest({ tag, assetNames: assets.map((a) => a.name) });
  writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n');
}
