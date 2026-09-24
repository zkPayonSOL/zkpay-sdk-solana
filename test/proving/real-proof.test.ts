import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { ARTIFACT_MANIFEST, createDefaultHasher, createProver, verifyArtifacts } from '../../src/proving/index.js';
import { depositWitness, signalsOf } from './fixtures.js';

const artifactDir = process.env.ZKPAY_TEST_ARTIFACTS;

test('explicit offline real Groth16 proof verifies with the pinned zkPay key', { skip: !artifactDir, timeout: 120_000 }, async () => {
  const artifacts = verifyArtifacts({
    wasm: await readFile(join(artifactDir!, ARTIFACT_MANIFEST.wasm.file)),
    zkey: await readFile(join(artifactDir!, ARTIFACT_MANIFEST.zkey.file)),
    verifyingKey: await readFile(join(artifactDir!, ARTIFACT_MANIFEST.verifyingKey.file)),
  });
  const input = depositWitness(await createDefaultHasher());
  const prover = createProver({ artifacts });
  // Prover must retain owned verified bytes despite mutation of caller storage after construction.
  artifacts.wasm.fill(0);
  artifacts.zkey.fill(0);
  const result = await prover.prove(input);
  const decimal = (bytes: number[]) => BigInt(`0x${Buffer.from(bytes).toString('hex')}`).toString();
  const g1 = (bytes: number[]) => [decimal(bytes.slice(0, 32)), decimal(bytes.slice(32, 64)), '1'];
  const proof = {
    protocol: 'groth16', curve: 'bn128', pi_a: g1(result.proofA), pi_c: g1(result.proofC),
    pi_b: [[decimal(result.proofB.slice(32, 64)), decimal(result.proofB.slice(0, 32))],
      [decimal(result.proofB.slice(96, 128)), decimal(result.proofB.slice(64, 96))], ['1', '0']],
  };
  // snarkjs.verify has no singleThread option in 0.7.6. Confine its workers to this child process.
  const worker = spawn(process.execPath, ['--input-type=module', '-e', `
    import { groth16 } from 'snarkjs';
    let data = ''; for await (const chunk of process.stdin) data += chunk;
    try {
      const { vk, signals, proof } = JSON.parse(data);
      const valid = await groth16.verify(vk, signals, proof);
      process.stdout.write(valid ? 'verified' : 'invalid', () => process.exit(valid ? 0 : 1));
    } catch { process.exit(2); }
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  worker.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  worker.stderr.resume();
  const exit = new Promise<number | null>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('close', resolve);
  });
  const timeout = setTimeout(() => worker.kill('SIGKILL'), 30_000);
  try {
    worker.stdin.end(JSON.stringify({ vk: JSON.parse(new TextDecoder().decode(artifacts.verifyingKey)), signals: signalsOf(input), proof }));
    assert.equal(await exit, 0);
    assert.equal(output, 'verified');
  } finally { clearTimeout(timeout); worker.kill(); }
});
