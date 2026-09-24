import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ARTIFACT_MANIFEST, downloadArtifact, verifyArtifact, createProver } from '../../src/proving/index.js';
import { depositWitness } from './fixtures.js';

test('artifact manifest is deeply immutable and rejects foreign artifact bytes', () => {
  assert.ok(Object.isFrozen(ARTIFACT_MANIFEST));
  assert.ok(Object.isFrozen(ARTIFACT_MANIFEST.wasm));
  assert.throws(() => { (ARTIFACT_MANIFEST.wasm as { sha256: string }).sha256 = '0'.repeat(64); }, TypeError);
  assert.throws(() => verifyArtifact('wasm', new Uint8Array(1)), /size/);
  assert.throws(() => verifyArtifact('verifyingKey', new Uint8Array(4022)), /SHA-256/);
  assert.throws(() => createProver({ artifacts: { wasm: new Uint8Array(1), zkey: new Uint8Array(1), verifyingKey: new Uint8Array(1) } }), /size/);
});

test('downloads reject HTTP errors, unexpected length, excess chunks, and incorrect hashes', async () => {
  await assert.rejects(downloadArtifact('wasm', { fetch: async () => new Response(null, { status: 503 }) }), /HTTP 503/);
  await assert.rejects(downloadArtifact('wasm', { fetch: async () => new Response('bad', { headers: { 'content-length': '3' } }) }), /size/);
  await assert.rejects(downloadArtifact('verifyingKey', { fetch: async () => new Response(new Uint8Array(4023)) }), /exceeds/);
  await assert.rejects(downloadArtifact('verifyingKey', { fetch: async () => new Response(new Uint8Array(4021)) }), /size/);
  await assert.rejects(downloadArtifact('verifyingKey', { fetch: async () => new Response(new Uint8Array(4022)) }), /SHA-256/);
});

test('download honors abort and bounds even a fetch implementation which ignores AbortSignal', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(downloadArtifact('wasm', { signal: controller.signal, fetch: async () => { called = true; throw new Error(); } }), { name: 'AbortError' });
  assert.equal(called, false);
  await assert.rejects(downloadArtifact('wasm', { timeoutMs: 15, fetch: () => new Promise(() => {}) }), { name: 'AbortError' });
  await assert.rejects(downloadArtifact('wasm', {
    timeoutMs: 15,
    fetch: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })),
  }), { name: 'AbortError' });
});

test('prover is lazy and a failed artifact load can be retried', async () => {
  let calls = 0;
  const prover = createProver({ fetch: async () => { calls++; return new Response(null, { status: 503 }); } });
  assert.equal(calls, 0);
  await assert.rejects(prover.prove(depositWitness()), /HTTP 503/);
  assert.equal(calls, 3);
  await assert.rejects(prover.prove(depositWitness()), /HTTP 503/);
  assert.equal(calls, 6);
});

test('download uses a fixed filename and does not send credentials or follow redirects', async () => {
  await assert.rejects(downloadArtifact('verifyingKey', {
    baseUrl: 'https://example.invalid/pinned',
    fetch: async (url, init) => {
      assert.equal(String(url), 'https://example.invalid/pinned/verifyingkey2.json');
      assert.equal(init?.credentials, 'omit');
      assert.equal(init?.redirect, 'error');
      return new Response(null, { status: 404 });
    },
  }), /HTTP 404/);
  await assert.rejects(downloadArtifact('wasm', { baseUrl: 'https://secret@example.invalid/' }), /credentials/);
});
