import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'buffer'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { PublicKey } from '@solana/web3.js'
import {
  ProtocolAccount, MerkleTree, FIELD_SIZE, buildTransactIx,
  type BuiltTransaction, type LeafRecord, type SerializedProof,
} from '../../src/protocol/index.js'
import { toBytes, fromBytes } from '../../src/protocol/validation.js'
import { extDataHashField } from '../../src/protocol/ext-data.js'
import { ARTIFACT_MANIFEST, createDefaultHasher, createProver, verifyArtifacts } from '../../src/proving/index.js'
import { quoteWithdrawal } from '../../src/fees.js'
import { MAINNET } from '../../src/networks.js'

const artifactDir = process.env.ZKPAY_TEST_ARTIFACTS
const decimal = (bytes: readonly number[]): string => fromBytes(Uint8Array.from(bytes)).toString()
const publicSignals = (proof: SerializedProof): string[] => [
  proof.root, proof.publicAmount, proof.extDataHash, ...proof.inputNullifiers, ...proof.outputCommitments,
].map(decimal)

function nativeProof(proof: SerializedProof) {
  const g1 = (bytes: number[]) => [decimal(bytes.slice(0, 32)), decimal(bytes.slice(32, 64)), '1']
  return {
    protocol: 'groth16', curve: 'bn128', pi_a: g1(proof.proofA), pi_c: g1(proof.proofC),
    pi_b: [
      [decimal(proof.proofB.slice(32, 64)), decimal(proof.proofB.slice(0, 32))],
      [decimal(proof.proofB.slice(96, 128)), decimal(proof.proofB.slice(64, 96))], ['1', '0'],
    ],
  }
}

/** One isolated verifier process reuses snarkjs's curve workers and always terminates them on exit. */
async function verifyCases(verifyingKey: Uint8Array, cases: { proof: ReturnType<typeof nativeProof>; signals: string[] }[]): Promise<boolean[]> {
  const worker = spawn(process.execPath, ['--input-type=module', '-e', `
    import { groth16 } from 'snarkjs';
    let data = ''; for await (const chunk of process.stdin) data += chunk;
    try {
      const { vk, cases } = JSON.parse(data);
      const results = [];
      for (const entry of cases) results.push(await groth16.verify(vk, entry.signals, entry.proof));
      process.stdout.write(JSON.stringify(results), () => process.exit(0));
    } catch { process.exit(2); }
  `], { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  worker.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  worker.stderr.resume()
  const exited = new Promise<number | null>((resolve, reject) => {
    worker.once('error', reject)
    worker.once('close', resolve)
    worker.stdin.once('error', reject)
  })
  const timeout = setTimeout(() => worker.kill('SIGKILL'), 45_000)
  try {
    worker.stdin.end(JSON.stringify({ vk: JSON.parse(new TextDecoder().decode(verifyingKey)), cases }))
    assert.equal(await exited, 0, 'isolated verifier must exit successfully within its deadline')
    return JSON.parse(output) as boolean[]
  } finally { clearTimeout(timeout); worker.kill() }
}

test('offline real deposit → scan → withdrawal → change roundtrip verifies and rejects altered gross/fee signals', {
  skip: !artifactDir, timeout: 180_000,
}, async t => {
  const artifacts = verifyArtifacts({
    wasm: await readFile(join(artifactDir!, ARTIFACT_MANIFEST.wasm.file)),
    zkey: await readFile(join(artifactDir!, ARTIFACT_MANIFEST.zkey.file)),
    verifyingKey: await readFile(join(artifactDir!, ARTIFACT_MANIFEST.verifyingKey.file)),
  })
  const hasher = await createDefaultHasher()
  const prover = createProver({ artifacts })
  // This publicly documented synthetic scalar and synthetic addresses carry no funds.
  const account = new ProtocolAccount(toBytes(1234567n, 32), hasher)
  const tree = new MerkleTree(hasher)
  const leaves: LeafRecord[] = []
  const recipient = new PublicKey(new Uint8Array(32).fill(41))
  const signer = new PublicKey(new Uint8Array(32).fill(42))
  const feeRecipient = new PublicKey(MAINNET.relayer)
  const programId = new PublicKey(MAINNET.programId)
  const depositAmount = 2_500_000_000n
  const withdrawalGross = 1_100_000_000n
  const quote = quoteWithdrawal(withdrawalGross)

  const append = (built: BuiltTransaction): void => {
    for (let index = 0; index < 2; index++) {
      const commitment = built.outputCommitments[index]!
      leaves.push({ index: tree.size, commitment,
        encryptedOutput: Buffer.from(index === 0 ? built.encryptedOutput1 : built.encryptedOutput2).toString('hex') })
      tree.append(commitment)
    }
  }
  const checkWire = (built: BuiltTransaction): void => {
    const instruction = buildTransactIx({ ...built, feeRecipient, signer, programId })
    const data = instruction.data
    assert.equal(data.length, 662)
    assert.deepEqual([...data.subarray(0, 8)], [217, 149, 130, 143, 221, 52, 252, 119])
    assert.deepEqual([...data.subarray(8, 72)], built.proof.proofA)
    assert.deepEqual([...data.subarray(72, 200)], built.proof.proofB)
    assert.deepEqual([...data.subarray(200, 264)], built.proof.proofC)
    const expected = publicSignals(built.proof)
    for (let index = 0; index < 7; index++) {
      const field = fromBytes(data.subarray(264 + 32 * index, 296 + 32 * index))
      assert.ok(field >= 0n && field < FIELD_SIZE)
      assert.equal(field.toString(), expected[index])
    }
    assert.equal(data.readBigInt64LE(488), built.extAmount)
    assert.equal(data.readBigUInt64LE(496), built.fee)
    assert.equal(data.readUInt32LE(504), 75)
    assert.equal(data.readUInt32LE(583), 75)
    assert.deepEqual([...data.subarray(508, 583)], [...built.encryptedOutput1])
    assert.deepEqual([...data.subarray(587, 662)], [...built.encryptedOutput2])
    assert.equal(instruction.keys[5]!.pubkey.toBase58(), built.recipient.toBase58())
    assert.equal(instruction.keys[6]!.pubkey.toBase58(), feeRecipient.toBase58())
  }

  try {
    const initialRoot = tree.root()
    const deposit = await account.buildDeposit({ tree, notes: [], amount: depositAmount, feeRecipient, prover })
    assert.equal(decimal(deposit.proof.root), initialRoot)
    assert.equal(decimal(deposit.proof.publicAmount), depositAmount.toString())
    assert.equal(deposit.extAmount, depositAmount)
    assert.equal(deposit.fee, 0n)
    checkWire(deposit)
    append(deposit)
    const deposited = account.scan(leaves)
    assert.equal(deposited.length, 1)
    assert.equal(deposited[0]!.index, 0)
    assert.equal(deposited[0]!.amount, depositAmount)
    t.diagnostic('Real deposit proof generated; encrypted output scanned at Merkle index 0.')

    const withdrawalRoot = tree.root()
    const withdrawal = await account.buildWithdrawal({
      tree, notes: deposited, gross: withdrawalGross, fee: quote.feeLamports, recipient, feeRecipient, prover,
    })
    assert.equal(decimal(withdrawal.proof.root), withdrawalRoot)
    assert.equal(decimal(withdrawal.proof.publicAmount), (FIELD_SIZE - withdrawalGross).toString())
    assert.equal(withdrawal.extAmount, -quote.recipientLamports)
    assert.equal(withdrawal.fee, quote.feeLamports)
    assert.equal(decimal(withdrawal.proof.inputNullifiers[0]!), deposited[0]!.nullifier)
    checkWire(withdrawal)
    append(withdrawal)
    const spent = new Set(withdrawal.proof.inputNullifiers.map(decimal))
    const change = account.scan(leaves).filter(note => !spent.has(note.nullifier))
    assert.equal(tree.size, 4)
    assert.equal(change.length, 1)
    assert.equal(change[0]!.index, 2)
    assert.equal(change[0]!.amount, depositAmount - withdrawalGross)
    t.diagnostic('Real withdrawal proof generated; spent-note filtering leaves the exact private change.')

    const depositSignals = publicSignals(deposit.proof)
    const withdrawalSignals = publicSignals(withdrawal.proof)
    const changedGross = [...withdrawalSignals]
    changedGross[1] = (FIELD_SIZE - withdrawalGross - 1n).toString()
    // Keep gross constant, increase fee by one and decrease recipient net by one.
    // Only the authenticated external-data signal changes, independently testing fee binding.
    const changedFee = [...withdrawalSignals]
    changedFee[2] = extDataHashField({ ...withdrawal, feeRecipient, fee: withdrawal.fee + 1n, extAmount: withdrawal.extAmount + 1n })
    assert.notEqual(changedFee[2], withdrawalSignals[2])
    const noncanonical = [...withdrawalSignals]
    noncanonical[1] = FIELD_SIZE.toString()
    const negative = [...withdrawalSignals]
    negative[1] = '-1'
    const depositProof = nativeProof(deposit.proof)
    const withdrawalProof = nativeProof(withdrawal.proof)
    assert.deepEqual(await verifyCases(artifacts.verifyingKey, [
      { proof: depositProof, signals: depositSignals },
      { proof: withdrawalProof, signals: withdrawalSignals },
      { proof: withdrawalProof, signals: changedGross },
      { proof: withdrawalProof, signals: changedFee },
      { proof: withdrawalProof, signals: noncanonical },
      { proof: withdrawalProof, signals: negative },
    ]), [true, true, false, false, false, false])
    assert.throws(() => buildTransactIx({ ...withdrawal, feeRecipient, signer, programId, fee: withdrawal.fee + 1n }), /does not match/)
  } finally { account.dispose() }
})
