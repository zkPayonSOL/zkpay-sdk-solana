#!/usr/bin/env node
// Run after npm run build. Downloads are explicit; importing the SDK never writes artifacts.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_MANIFEST, downloadArtifacts } from '../dist/proving/index.js';

const output = new URL('../.artifacts/', import.meta.url);
const artifacts = await downloadArtifacts();
// All three immutable hashes must pass before any artifact is stored.
await mkdir(output, { recursive: true, mode: 0o700 });
for (const [name, descriptor] of Object.entries(ARTIFACT_MANIFEST)) {
  await writeFile(new URL(descriptor.file, output), artifacts[name], { mode: 0o600 });
}
console.log(`Verified zkPay protocol artifacts saved to ${fileURLToPath(output)}`);
