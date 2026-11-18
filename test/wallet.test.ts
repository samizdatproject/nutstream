import { describe, it, expect, beforeEach } from 'vitest';
import { NutWallet } from '../src/core/wallet.ts';
import { MemoryStore, Lock } from '../src/core/store.ts';
import { emptyState, sumProofs } from '../src/core/types.ts';
import { MockReceiver } from '../src/mock/receiver.ts';
import type { FetchLike } from '../src/core/routeB.ts';
import { FakeLedger, MINT, proof } from './fakes.ts';

const TARGET = { url: 'https://show.test/api/community/ecash-payment' };

let ledger: FakeLedger, store: MemoryStore, receiver: MockReceiver, clock: number;
const now = () => clock;

async function walletWith(amounts: number[], fetch?: FetchLike) {
  const s = emptyState(MINT);
  s.proofs = amounts.map(proof);
  await store.save(s);
  return open(fetch);
}
const open = (fetch?: FetchLike) =>
  new NutWallet({ store, ledger, fetch: fetch ?? receiver.asFetch(), now, postGapMs: 0, lock: new Lock(`t${Math.random()}`) }).open();

beforeEach(() => {
  ledger = new FakeLedger();
  store = new MemoryStore();
  clock = 1_000_000;
  receiver = new MockReceiver({ acceptedMints: [MINT], redeem: ledger.redeem, now, perMinute: 1000 });
});

describe('outbox', () => {
  it('pays a streaming batch: show gets the amount, fee is counted, change stays', async () => {
    const w = await walletWith([64, 32, 4]);
    await w.addOwed(10, TARGET);
    await w.queueOwed();
    const r = await w.pump();
    expect(r.done).toHaveLength(1);
    expect(receiver.total).toBe(10);
    expect(receiver.received[0].kind).toBe('stream');
    const s = w.snapshot();
    expect(s.paid).toBe(10);
    expect(s.fees).toBe(1);
    expect(s.owed).toBe(0);
    expect(w.balance).toBe(100 - 10 - 1);
  });

  it('a boost goes without ?action=stream and carries the memo', async () => {
    const w = await walletWith([64]);
    await w.queueBoost(TARGET, 21, 'great episode');
    await w.pump();
    expect(receiver.received[0]).toMatchObject({ kind: 'boost', amount: 21, memo: 'great episode' });
  });

  it('closing the tab after the swap was prepared loses nothing: the next load replays the same swap', async () => {
    let w = await walletWith([64]);
    await w.addOwed(5, TARGET);
    await w.queueOwed();
    ledger.failSwap = 1; // swap request never reaches the mint
    await w.pump();
    expect(w.snapshot().batches[0].status).toBe('prepared');
    expect(w.balance).toBe(0); // the input lives only in the persisted preview
    clock += 60_000;
    w = await open(); // "reload the page"
    await w.pump();
    expect(receiver.total).toBe(5);
    expect(ledger.swaps).toBe(1);
    expect(w.balance).toBe(64 - 5 - 1);
  });

  it('a lost swap reply is replayed from the mint cache, not swapped twice', async () => {
    const w = await walletWith([64]);
    await w.queueBoost(TARGET, 8, '');
    ledger.loseSwapReply = 1;
    await w.pump();
    clock += 60_000;
    await w.pump();
    expect(ledger.swaps).toBe(1);
    expect(receiver.total).toBe(8);
    expect(w.balance).toBe(64 - 8 - 1);
  });

  it('a lost POST reply is retried and counts as paid once (already_redeemed)', async () => {
    let calls = 0;
    const flaky: FetchLike = async (url, init) => {
      const res = await receiver.asFetch()(url, init);
      if (++calls === 1) throw new Error('reply lost');
      return res;
    };
    const w = await walletWith([64], flaky);
    await w.queueBoost(TARGET, 10, '');
    await w.pump();
    expect(w.snapshot().batches[0].status).toBe('ready');
    clock += 60_000;
    await w.pump();
    expect(w.snapshot().batches[0].status).toBe('done');
    expect(receiver.total).toBe(10);
    expect(w.snapshot().paid).toBe(10);
  });

  it('amount_too_small returns the proofs and puts the sats back into owed', async () => {
    receiver.opts.minSats = 20;
    const w = await walletWith([64]);
    await w.addOwed(5, TARGET);
    await w.queueOwed();
    await w.pump();
    const s = w.snapshot();
    expect(s.batches[0].status).toBe('returned');
    expect(s.owed).toBe(5);
    expect(w.balance).toBe(64 - 1); // only the swap fee is gone
  });

  it('untrusted_mint blocks the batch, returns the proofs and reports accepted mints', async () => {
    receiver.opts.acceptedMints = ['https://other.mint'];
    const w = await walletWith([64]);
    await w.queueBoost(TARGET, 10, '');
    await w.pump();
    const b = w.snapshot().batches[0];
    expect(b.status).toBe('blocked');
    expect(b.acceptedMints).toEqual(['https://other.mint']);
    expect(w.balance).toBe(63);
  });

  it('disabled pauses for 30 minutes; other errors back off and retry', async () => {
    receiver.opts.disabled = true;
    const w = await walletWith([64]);
    await w.queueBoost(TARGET, 10, '');
    await w.pump();
    let b = w.snapshot().batches[0];
    expect(b.status).toBe('ready');
    expect(b.nextAt - clock).toBe(30 * 60_000);
    receiver.opts.disabled = false;
    clock += 10 * 60_000;
    await w.pump();
    expect(w.snapshot().batches[0].status).toBe('ready'); // still waiting
    clock += 21 * 60_000;
    await w.pump();
    b = w.snapshot().batches[0];
    expect(b.status).toBe('done');
  });

  it('invalid_payload is a sender bug: not retried, proofs come back', async () => {
    const broken: FetchLike = async (url, init) => receiver.asFetch()(url, { ...init, body: '{"mint":1}' });
    const w = await walletWith([64], broken);
    await w.queueBoost(TARGET, 10, '');
    await w.pump();
    expect(w.snapshot().batches[0].status).toBe('failed');
    expect(w.balance).toBe(63);
  });

  it('waits when the wallet is empty and pays once funded', async () => {
    const w = await walletWith([]);
    await w.queueBoost(TARGET, 10, '');
    await w.pump();
    expect(w.snapshot().batches[0]).toMatchObject({ status: 'new', lastError: 'insufficient-funds' });
  });

  it('two pumps at once never pick the same proofs', async () => {
    const lock = new Lock('shared');
    const s = emptyState(MINT);
    s.proofs = [proof(64)];
    await store.save(s);
    const w = await new NutWallet({ store, ledger, fetch: receiver.asFetch(), now, postGapMs: 0, lock }).open();
    await w.queueBoost(TARGET, 10, '');
    await Promise.all([w.pump(), w.pump(), w.pump()]);
    expect(ledger.swaps).toBe(1);
    expect(receiver.total).toBe(10);
  });

  it('a swap that keeps failing with unspent inputs starts over', async () => {
    const w = await walletWith([64]);
    await w.queueBoost(TARGET, 10, '');
    ledger.failSwap = 3;
    for (let i = 0; i < 3; i++) { await w.pump(); clock += 10 * 60_000; }
    expect(w.snapshot().batches[0].status).toBe('new');
    expect(w.balance).toBe(64);
    await w.pump();
    expect(w.snapshot().batches[0].status).toBe('done');
  });

  it('a lost swap reply after the cache window is recovered with NUT-09 restore, not written off', async () => {
    const w = await walletWith([64]);
    await w.queueBoost(TARGET, 10, '');
    ledger.loseSwapReply = 1;
    ledger.cacheWorks = false; // the replay fails: the reply was lost and the cache window passed
    await w.pump();
    clock += 10 * 60_000;
    await w.pump();
    expect(w.snapshot().batches[0].status).toBe('done');
    expect(receiver.total).toBe(10);
    expect(w.balance).toBe(64 - 10 - 1);
  });

  it('while restore is unavailable the preview is kept (never deleted) and the batch waits', async () => {
    const w = await walletWith([64]);
    await w.queueBoost(TARGET, 10, '');
    ledger.loseSwapReply = 1;
    ledger.cacheWorks = false;
    ledger.restoreWorks = false;
    for (let i = 0; i < 5; i++) { await w.pump(); clock += 10 * 60_000; }
    const b = w.snapshot().batches[0];
    expect(b.status).toBe('prepared');
    expect(b.swapPreview).toBeTruthy();
    ledger.restoreWorks = true;
    await w.pump();
    expect(w.snapshot().batches[0].status).toBe('done');
  });

  it('two tabs (two instances, one store) never overwrite each other', async () => {
    const lock = new Lock('tabs');
    const s = emptyState(MINT);
    s.proofs = [proof(64)];
    await store.save(s);
    const a = await new NutWallet({ store, ledger, fetch: receiver.asFetch(), now, postGapMs: 0, lock }).open();
    const b = await new NutWallet({ store, ledger, fetch: receiver.asFetch(), now, postGapMs: 0, lock }).open();
    await a.queueBoost(TARGET, 10, '');
    await a.pump(); // tab A pays; change 53 is stored
    await b.addOwed(1, TARGET); // tab B was opened before; it must not write its stale copy back
    const saved = (await store.load())!;
    expect(sumProofs(saved.proofs)).toBe(53);
    expect(saved.batches).toHaveLength(1);
    expect(saved.owed).toBe(1);
    await b.pump();
    expect(receiver.total).toBe(10); // B does not pay A's batch again
  });

  it('a failed save aborts the step and the next run continues from the last saved state', async () => {
    const s = emptyState(MINT);
    s.proofs = [proof(64)];
    await store.save(s);
    let failNext = false;
    const flakyStore = { load: () => store.load(), save: async (x: any) => { if (failNext) { failNext = false; throw new Error('QuotaExceeded'); } return store.save(x); } };
    const w = await new NutWallet({ store: flakyStore, ledger, fetch: receiver.asFetch(), now, postGapMs: 0, lock: new Lock('f') }).open();
    await w.queueBoost(TARGET, 10, '');
    failNext = true; // the save right after prepare fails
    await expect(w.pump()).rejects.toThrow(/could not save/);
    expect(ledger.swaps).toBe(0);
    await w.pump();
    expect(receiver.total).toBe(10);
    expect(sumProofs((await store.load())!.proofs)).toBe(53);
  });

  it('amount_too_small with the mint unreachable does not count the sats twice', async () => {
    receiver.opts.minSats = 20;
    const w = await walletWith([64]);
    await w.addOwed(5, TARGET);
    await w.queueOwed();
    ledger.stateCheckWorks = false;
    await w.pump();
    clock += 10 * 60_000;
    await w.pump();
    expect(w.snapshot().owed).toBe(0);
    ledger.stateCheckWorks = true;
    clock += 10 * 60_000;
    await w.pump();
    expect(w.snapshot().owed).toBe(5);
  });

  it('rejects plain-http endpoints (bearer tokens in cleartext)', async () => {
    const w = await walletWith([64]);
    await expect(w.queueBoost({ url: 'http://show.example/pay' }, 5, '')).rejects.toThrow(/https/);
    await expect(w.queueBoost({ url: 'not a url' }, 5, '')).rejects.toThrow(/https/);
  });

  it('cancels a stuck payment by swapping its proofs back', async () => {
    receiver.opts.disabled = true;
    const w = await walletWith([64]);
    const b = await w.queueBoost(TARGET, 10, '');
    await w.pump();
    expect(await w.cancel(b.id)).toBe(true);
    expect(w.snapshot().batches[0]).toMatchObject({ status: 'failed', lastError: 'cancelled' });
    expect(w.balance).toBe(63);
  });

  it('a paid invoice is minted even after the tab was closed', async () => {
    let w = await walletWith([]);
    const inv = await w.createInvoice(100);
    w = await open(); // closed the tab before paying
    ledger.paidQuotes.add(inv.quote);
    expect(await w.claimInvoices()).toBe(100);
    expect(w.balance).toBe(100);
    expect(w.snapshot().quotes).toHaveLength(0);
  });

  it('a minted invoice whose reply was lost is restored (NUT-09), never dropped', async () => {
    const w = await walletWith([]);
    const inv = await w.createInvoice(100);
    ledger.paidQuotes.add(inv.quote);
    ledger.loseMintReply = 1;
    ledger.cacheWorks = false; // and the cache window passed
    ledger.restoreWorks = false; // and the mint is unreachable for a while
    expect(await w.claimInvoices()).toBe(0);
    expect(w.snapshot().quotes).toHaveLength(1); // kept, with its saved mint request
    expect(w.snapshot().quotes[0].preview).toBeTruthy();
    ledger.restoreWorks = true;
    expect(await w.claimInvoices()).toBe(100);
    expect(w.balance).toBe(100);
    expect(w.snapshot().quotes).toHaveLength(0);
  });

  it('cancelling after the show already redeemed counts the payment as paid', async () => {
    let calls = 0;
    const lateReply: FetchLike = async (url, init) => { const r = await receiver.asFetch()(url, init); if (++calls <= 2) throw new Error('timeout'); return r; };
    const w = await walletWith([64], lateReply);
    const b = await w.queueBoost(TARGET, 10, '');
    await w.pump(); // the show redeemed, but the reply never came
    expect(receiver.total).toBe(10);
    expect(await w.cancel(b.id)).toBe(true);
    const s = w.snapshot();
    expect(s.batches[0].status).toBe('done');
    expect(s.paid).toBe(10);
    expect(s.receives).toHaveLength(0);
  });

  it('a swap whose inputs were spent by some other swap fails clearly instead of retrying forever', async () => {
    const w = await walletWith([64]);
    await w.queueBoost(TARGET, 10, '');
    ledger.failSwap = 1;
    await w.pump(); // prepared
    const inputs = ledger.previewInputs(w.snapshot().batches[0].swapPreview!);
    for (const p of inputs) ledger.spent.add(p.secret); // spent elsewhere
    ledger.failSwap = 1;
    clock += 10 * 60_000;
    await w.pump();
    expect(w.snapshot().batches[0]).toMatchObject({ status: 'failed' });
  });

  it('receiving an already-spent token closes the entry; the same token is not received twice at once', async () => {
    const w = await walletWith([]);
    const token = [proof(30)];
    for (const p of token) ledger.spent.add(p.secret);
    await expect(w.receiveToken(token as any)).rejects.toThrow(/already spent/);
    expect(w.snapshot().receives).toHaveLength(0);
    const fresh = [proof(20)];
    ledger.failSwap = 1;
    await expect(w.receiveToken(fresh as any)).rejects.toThrow();
    await expect(w.receiveToken(fresh as any)).rejects.toThrow(/already being received/);
  });

  it('a token receive interrupted mid-swap finishes on the next visit', async () => {
    let w = await walletWith([]);
    const token = [proof(30)];
    ledger.failSwap = 1;
    await expect(w.receiveToken(token as any)).rejects.toThrow();
    expect(w.snapshot().receives).toHaveLength(1);
    w = await open();
    await w.resumeReceives();
    expect(w.balance).toBe(30);
    expect(w.snapshot().receives).toHaveLength(0);
  });

  it('metered sats survive a reload, and exportAll empties the wallet into one token', async () => {
    let w = await walletWith([64, 8]);
    await w.addOwed(7, TARGET);
    w = await open();
    expect(w.snapshot().owed).toBe(7);
    const out = await w.exportAll();
    expect(out).toMatchObject({ token: 'cashuBfake72', amount: 72 });
    expect(w.balance).toBe(0);
    w = await open(); // the token survives a crash until the user confirms
    expect((await w.exportAll())!.token).toBe('cashuBfake72');
    await w.clearExport();
    expect(w.snapshot().pendingExport).toBeUndefined();
  });

  it('sats owed to one show are queued for that show before another show starts accruing', async () => {
    const w = await walletWith([64, 64]);
    const other = { url: 'https://other.show/api/community/ecash-payment' };
    await w.addOwed(4, TARGET);
    await w.addOwed(6, other); // switched shows: the 4 sats go to TARGET
    await w.queueOwed();
    const s = w.snapshot();
    expect(s.batches.map((b) => [b.target.url, b.amount])).toEqual([[TARGET.url, 4], [other.url, 6]]);
  });

  it('refuses to open a store that holds another mint\'s wallet (never overwrites it)', async () => {
    const s = emptyState('https://other.mint');
    s.proofs = [proof(64)];
    await store.save(s);
    await expect(open()).rejects.toThrow(/other.mint/);
    expect((await store.load())!.proofs).toHaveLength(1);
  });

  it('spaces POSTs to one host by the configured gap (rate limit)', async () => {
    const s = emptyState(MINT);
    s.proofs = [proof(64), proof(64)];
    await store.save(s);
    const w = await new NutWallet({ store, ledger, fetch: receiver.asFetch(), now, postGapMs: 7_000, lock: new Lock('gap') }).open();
    await w.queueBoost(TARGET, 5, '');
    await w.queueBoost(TARGET, 5, '');
    await w.pump();
    expect(receiver.received).toHaveLength(1);
    clock += 7_000;
    await w.pump();
    expect(receiver.received).toHaveLength(2);
  });
});
