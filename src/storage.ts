import type { LeafRecord } from './protocol/index.js'

/** Only public chain data belongs in this cache. Spend keys and decrypted notes never do. */
export interface PublicPoolCache {
  readonly version: 1
  readonly namespace: string
  readonly leaves: readonly LeafRecord[]
}
export interface PoolStorage {
  load(namespace: string): Promise<PublicPoolCache | null | undefined>
  save(namespace: string, snapshot: PublicPoolCache): Promise<void>
  remove(namespace: string): Promise<void>
}
export type PublicPoolStorage = PoolStorage

function clone(snapshot: PublicPoolCache): PublicPoolCache {
  return { version: 1, namespace: snapshot.namespace,
    leaves: snapshot.leaves.map(leaf => ({ index: leaf.index, commitment: leaf.commitment, encryptedOutput: leaf.encryptedOutput })) }
}

/** Optional isolated memory cache; the synchronizer does not persist anything by default. */
export class MemoryPoolStorage implements PoolStorage {
  #snapshots = new Map<string, PublicPoolCache>()
  async load(namespace: string): Promise<PublicPoolCache | undefined> {
    const snapshot = this.#snapshots.get(namespace)
    return snapshot ? clone(snapshot) : undefined
  }
  async save(namespace: string, snapshot: PublicPoolCache): Promise<void> {
    if (snapshot.version !== 1 || snapshot.namespace !== namespace) throw new TypeError('Cache namespace mismatch.')
    this.#snapshots.set(namespace, clone(snapshot))
  }
  async remove(namespace: string): Promise<void> { this.#snapshots.delete(namespace) }
}
