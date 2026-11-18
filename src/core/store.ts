// Persistence: the whole wallet state is one JSON document, written in a single put, so every change is atomic.
// IndexedDB in the browser (database name namespaced to this app), memory in tests.
import type { WalletState } from './types.ts';

export interface Store {
  load(): Promise<WalletState | undefined>;
  save(state: WalletState): Promise<void>;
}

export class MemoryStore implements Store {
  private doc?: string;
  async load() { return this.doc ? (JSON.parse(this.doc) as WalletState) : undefined; }
  async save(state: WalletState) { this.doc = JSON.stringify(state); }
}

const DB = 'nutstream-v1';
const OS = 'state';

/** One wallet per mint: the IndexedDB key for a mint's wallet. */
export const walletStoreKey = (mintUrl: string) => `wallet:${mintUrl.replace(/\/+$/, '')}`;

export class IdbStore implements Store {
  constructor(private key: string) {}
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(OS);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('the wallet database is blocked by another tab'));
    });
  }
  async load() {
    const db = await this.open();
    try {
      return await new Promise<WalletState | undefined>((resolve, reject) => {
        const r = db.transaction(OS, 'readonly').objectStore(OS).get(this.key);
        r.onsuccess = () => resolve(r.result ? (JSON.parse(r.result) as WalletState) : undefined);
        r.onerror = () => reject(r.error);
      });
    } finally { db.close(); }
  }
  async save(state: WalletState) {
    const db = await this.open();
    try {
      await new Promise<void>((resolve, reject) => {
        // strict: report success only after the write reached disk (Chrome defaults to relaxed)
        const tx = db.transaction(OS, 'readwrite', { durability: 'strict' } as IDBTransactionOptions);
        tx.objectStore(OS).put(JSON.stringify(state), this.key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
}

/**
 * Serializes wallet work: one operation at a time in this page, and (where the browser supports Web Locks)
 * one at a time across tabs of the same origin, so two tabs never pick the same proofs.
 */
export class Lock {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private name = 'nutstream-wallet') {}
  run<T>(fn: () => Promise<T>): Promise<T> {
    const locks = (globalThis as any).navigator?.locks;
    const task = () => (locks ? locks.request(this.name, () => fn()) : fn());
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next as Promise<T>;
  }
}

/** Ask the browser not to evict this site's storage (the wallet holds bearer ecash). Returns whether it agreed. */
export async function requestPersistentStorage(): Promise<boolean> {
  try { return (await (navigator as any).storage?.persist?.()) === true; } catch { return false; }
}
