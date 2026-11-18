import { describe, it, expect, beforeEach } from 'vitest';
import { verifyEvent, type Event } from 'nostr-tools/pure';
import { NutWallet } from '../src/core/wallet.ts';
import { MemoryStore, Lock } from '../src/core/store.ts';
import { emptyState, type RouteATarget } from '../src/core/types.ts';
import { parseNutzapInfo, normalizeP2pk, buildNutzap } from '../src/core/nostr.ts';
import { FakeLedger, MINT, proof } from './fakes.ts';

const SHOW = 'ab'.repeat(32);
const P2PK = '02' + 'cd'.repeat(32);
const TARGET: RouteATarget = { route: 'A', p: SHOW, p2pk: P2PK, mints: [MINT + '/'], relays: ['wss://relay.test'] };

let ledger: FakeLedger, store: MemoryStore, clock: number, published: { ev: Event; relays: string[] }[], relayUp: boolean;
let lookupResult: RouteATarget | undefined;
const now = () => clock;
const publish = async (ev: Event, relays: string[]) => {
  if (!relayUp) return { accepted: 0, errors: ['wss://relay.test: connection failed'] };
  published.push({ ev, relays });
  return { accepted: 1, errors: [] };
};
async function walletWith(amounts: number[]) {
  const s = emptyState(MINT);
  s.proofs = amounts.map(proof);
  await store.save(s);
  return new NutWallet({ store, ledger, fetch: async () => { throw new Error('no HTTP in route A'); }, publish, now, postGapMs: 0,
    lookup: async () => lookupResult && { ...lookupResult, fetchedAt: clock }, fallbackRelays: ['wss://fallback.test'], lock: new Lock(`a${Math.random()}`) }).open();
}

beforeEach(() => { ledger = new FakeLedger(); store = new MemoryStore(); clock = 1_000_000; published = []; relayUp = true; lookupResult = TARGET; });

describe('route A (NIP-61 nutzaps)', () => {
  it('locks to the show\'s P2PK key and publishes a valid kind:9321 with the mint exactly as listed', async () => {
    const w = await walletWith([64]);
    await w.queueBoost(TARGET, 21, 'great show');
    await w.pump();
    expect(ledger.lastP2pk).toBe(P2PK);
    expect(published).toHaveLength(1);
    const ev = published[0].ev;
    expect(verifyEvent(ev)).toBe(true);
    expect(ev.kind).toBe(9321);
    expect(ev.content).toBe('great show');
    expect(ev.tags).toContainEqual(['u', MINT + '/']); // EXACTLY the 10019 string, trailing slash included
    expect(ev.tags).toContainEqual(['p', SHOW]);
    expect(ev.tags).toContainEqual(['unit', 'sat']);
    const proofs = ev.tags.filter((t) => t[0] === 'proof').map((t) => JSON.parse(t[1]));
    expect(proofs.reduce((s, p) => s + p.amount, 0)).toBe(21);
    expect(published[0].relays).toEqual(['wss://relay.test']);
    expect(w.snapshot().batches[0].status).toBe('done');
  });

  it('refuses a mint the show does not list (no swap, no fee)', async () => {
    const w = await walletWith([64]);
    await w.queueBoost({ ...TARGET, mints: ['https://other.mint'], fetchedAt: clock }, 10, '');
    await w.pump();
    expect(w.snapshot().batches[0]).toMatchObject({ status: 'blocked', acceptedMints: ['https://other.mint'] });
    expect(ledger.swaps).toBe(0);
    expect(w.balance).toBe(64);
  });

  it('splits streaming sats into silent nutzaps under 100 sats (so they count as streaming, not boosts)', async () => {
    const w = await walletWith([256, 64]);
    await w.addOwed(250, TARGET);
    await w.queueOwed();
    expect(w.snapshot().batches.map((b) => b.amount)).toEqual([99, 99, 52]);
    await w.pump();
    expect(published.map((p) => p.ev.content)).toEqual(['', '', '']);
  });

  it('retries publishing the identical saved event when relays are down, and cannot be cancelled once locked', async () => {
    relayUp = false;
    const w = await walletWith([64]);
    const b = await w.queueBoost(TARGET, 10, '');
    await w.pump();
    const saved = w.snapshot().batches[0];
    expect(saved.status).toBe('ready');
    const id = JSON.parse(saved.event!).id;
    expect(await w.cancel(b.id)).toBe(false);
    relayUp = true;
    clock += 10 * 60_000;
    await w.pump();
    expect(published[0].ev.id).toBe(id);
    expect(w.snapshot().batches[0].status).toBe('done');
  });

  it('parses a kind:10019 (unit lists, 64-hex key gets the 02 prefix) and rejects unusable ones', () => {
    const t = parseNutzapInfo({ tags: [['relay', 'wss://r1/'], ['mint', 'https://m1', 'usd'], ['mint', 'https://m2', 'usd', 'sat'], ['mint', 'https://m3'], ['pubkey', 'ef'.repeat(32)]] }, SHOW);
    expect(t).toMatchObject({ relays: ['wss://r1'], mints: ['https://m2', 'https://m3'], p2pk: '02' + 'ef'.repeat(32) });
    expect(parseNutzapInfo({ tags: [['relay', 'wss://r1'], ['mint', 'https://m1']] }, SHOW)).toBeUndefined();
    expect(normalizeP2pk('03' + 'aa'.repeat(32))).toBe('02' + 'aa'.repeat(32)); // NIP-61: always 02 (same x-only key)
    expect(normalizeP2pk('xyz')).toBeUndefined();
  });

  it('on a fee-charging mint, keeps every streaming nutzap\'s proof total under 100 (never booked as a boost)', async () => {
    ledger.receiverFee = 1; // includeFees adds the show's redeem fee to what it receives
    const w = await walletWith([256, 64]);
    await w.addOwed(250, TARGET);
    await w.queueOwed();
    await w.pump();
    clock += 60_000;
    await w.pump();
    const amounts = w.snapshot().batches.map((b) => b.amount);
    expect(amounts.reduce((s, a) => s + a, 0)).toBe(250);
    expect(Math.max(...amounts)).toBeLessThanOrEqual(98); // 98 + 1 fee = 99
    expect(published.every((p) => p.ev.content === '')).toBe(true);
  });

  it('re-reads the show\'s kind:10019 before locking an old snapshot, and waits if it cannot', async () => {
    const w = await walletWith([64]);
    const rotated = { ...TARGET, p2pk: '02' + 'ee'.repeat(32) };
    await w.queueBoost({ ...TARGET, fetchedAt: clock - 60 * 60_000 }, 21, 'hi');
    lookupResult = undefined; // relays unreachable
    await w.pump();
    expect(w.snapshot().batches[0]).toMatchObject({ status: 'new' });
    expect(ledger.swaps).toBe(0);
    lookupResult = rotated; // the show rotated its key meanwhile
    clock += 10 * 60_000;
    await w.pump();
    expect(ledger.lastP2pk).toBe(rotated.p2pk);
    expect(w.snapshot().batches[0].status).toBe('done');
  });

  it('a silent boost under 100 sats gets a short note so it is booked as a boost', async () => {
    const w = await walletWith([64]);
    await w.queueBoost(TARGET, 21, '');
    await w.pump();
    expect(published[0].ev.content).toBe('boost');
  });

  it('after repeated refusals also tries fallback relays', async () => {
    relayUp = false;
    const w = await walletWith([64]);
    await w.queueBoost(TARGET, 10, 'x');
    for (let i = 0; i < 4; i++) { await w.pump(); clock += 10 * 60_000; }
    relayUp = true;
    await w.pump();
    expect(published[0].relays).toEqual(['wss://relay.test', 'wss://fallback.test']);
  });

  it('signs each nutzap with a fresh key (payments are not linkable by signer)', () => {
    const a = buildNutzap([{ id: 'k', amount: 1, secret: 's', C: 'c' }], MINT, SHOW, '');
    const b = buildNutzap([{ id: 'k', amount: 1, secret: 's2', C: 'c2' }], MINT, SHOW, '');
    expect(a.pubkey).not.toBe(b.pubkey);
  });
});
