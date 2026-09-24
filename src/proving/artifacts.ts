import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

export type ArtifactName = 'wasm' | 'zkey' | 'verifyingKey';
export interface ArtifactDescriptor { readonly file: string; readonly sha256: string; readonly size: number; }
export type ArtifactBytes = { [K in ArtifactName]: Uint8Array };

/** zkPay transaction2 protocol artifacts. Changing these requires a protocol release. */
export const ARTIFACT_MANIFEST: Readonly<Record<ArtifactName, ArtifactDescriptor>> = Object.freeze({
  wasm: Object.freeze({ file: 'transaction2.wasm', sha256: 'a277631b7616c2c0bfd78a1648b069972ac6020e5509ae8f9bfc8772bdc70ec1', size: 3208099 }),
  zkey: Object.freeze({ file: 'transaction2.zkey', sha256: '018ae5ce79df66c4bb86a384b96a68d0db3513902078823aa0bfe07f99f2813d', size: 16462377 }),
  verifyingKey: Object.freeze({ file: 'verifyingkey2.json', sha256: 'b8bf705bb74bda38c3ec609e3eb0bc4eda777a4504ff524b794d494df9b61467', size: 4022 }),
});
export const DEFAULT_ARTIFACT_BASE_URL = 'https://app.zkpay.sh/artifacts/';

/** Return an owned, verified copy; never trust caller-owned mutable bytes after checking. */
export function verifyArtifact(name: ArtifactName, bytes: Uint8Array): Uint8Array {
  if (!Object.hasOwn(ARTIFACT_MANIFEST, name)) throw new TypeError('Unknown protocol artifact');
  const expected = ARTIFACT_MANIFEST[name];
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== expected.size) {
    throw new Error(`Invalid ${name} artifact size; expected ${expected.size} bytes`);
  }
  const copy = Uint8Array.from(bytes);
  if (bytesToHex(sha256(copy)) !== expected.sha256) throw new Error(`Invalid ${name} artifact SHA-256`);
  return copy;
}

export function verifyArtifacts(bytes: ArtifactBytes): ArtifactBytes {
  if (!bytes || typeof bytes !== 'object') throw new TypeError('Protocol artifact bytes are required');
  return {
    wasm: verifyArtifact('wasm', bytes.wasm),
    zkey: verifyArtifact('zkey', bytes.zkey),
    verifyingKey: verifyArtifact('verifyingKey', bytes.verifyingKey),
  };
}

export interface ArtifactDownloadOptions {
  /** Host the exact pinned bytes here, including for a browser's static assets. */
  baseUrl?: string | URL;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  /** Applies to each complete artifact response, including streaming its body. */
  timeoutMs?: number;
}

function aborted(): Error { return new DOMException('Artifact download aborted', 'AbortError'); }

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(aborted());
    // Attach rejection handling even if cancellation won the race with the producer.
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) { reject(aborted()); return; }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Explicit network operation; the module and prover constructor never start downloads. */
export async function downloadArtifact(name: ArtifactName, options: ArtifactDownloadOptions = {}): Promise<Uint8Array> {
  if (!Object.hasOwn(ARTIFACT_MANIFEST, name)) throw new TypeError('Unknown protocol artifact');
  const expected = ARTIFACT_MANIFEST[name];
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new RangeError('Artifact timeout must be 1 to 600000 milliseconds');
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== 'function') throw new Error('Artifact download requires fetch');
  const base = new URL(options.baseUrl ?? DEFAULT_ARTIFACT_BASE_URL);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new TypeError('Artifact base URL must be an HTTP(S) directory without credentials, query, or fragment');
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const url = new URL(expected.file, base);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(onAbort, timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (controller.signal.aborted) throw aborted();
    const response = await withAbort(fetcher(url, { signal: controller.signal, credentials: 'omit', redirect: 'error' }), controller.signal);
    reader = response.body?.getReader();
    if (!response.ok) throw new Error(`Artifact download failed (HTTP ${response.status})`);
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) !== expected.size)) {
      throw new Error(`Invalid ${name} artifact response size`);
    }
    if (!reader) throw new Error('Artifact download returned no body');
    const data = new Uint8Array(expected.size);
    let length = 0;
    while (true) {
      const next = await withAbort(reader.read(), controller.signal);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || next.value.byteLength > expected.size - length) {
        throw new Error(`Artifact response exceeds the pinned ${name} size`);
      }
      data.set(next.value, length);
      length += next.value.byteLength;
    }
    if (length !== expected.size) throw new Error(`Invalid ${name} artifact response size`);
    if (controller.signal.aborted) throw aborted();
    return verifyArtifact(name, data);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    if (reader) {
      // Do not let a broken custom stream's cancellation delay the caller forever.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    controller.abort();
  }
}

export async function downloadArtifacts(options: ArtifactDownloadOptions = {}): Promise<ArtifactBytes> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const shared = { ...options, signal: controller.signal };
  try {
    const [wasm, zkey, verifyingKey] = await Promise.all([
      downloadArtifact('wasm', shared), downloadArtifact('zkey', shared), downloadArtifact('verifyingKey', shared),
    ]);
    return { wasm, zkey, verifyingKey };
  } finally {
    // A failing artifact cancels its siblings, so a retry cannot accumulate stale downloads.
    controller.abort();
    options.signal?.removeEventListener('abort', onAbort);
  }
}
