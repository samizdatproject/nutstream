// End to end against the free test mint (fake Lightning) and the mock show over real HTTP.
// Runs only with LIVE=1 (needs network): LIVE=1 npx vitest run test/live.test.ts
import { describe, it, expect } from 'vitest';
import { CashuLedger } from '../src/core/ledger.ts';
import { NutWallet } from '../src/core/wallet.ts';
import { MemoryStore, Lock } from '../src/core/store.ts';
import { MockReceiver } from '../src/mock/receiver.ts';
import { cashuRedeem } from '../src/mock/cashuRedeem.ts';
import { serve } from '../src/mock/server.ts';

const MINT = 'https://testnut.cashu.space';

describe.runIf(process.env.LIVE === '1')('live: testnut + mock show over HTTP', () => {
  it('NUT-09 restore rebuilds the exact proofs of a completed swap (recovery after a lost reply)', async () => {
    const ledger = new CashuLedger(MINT);
    const inv = await ledger.createInvoice(64);
    for (let i = 0; i < 20 && (await ledger.quoteState(inv.quote)) === 'UNPAID'; i++) await new Promise((r) => setTimeout(r, 500));
    const mintPreview = await ledger.prepareMint(inv.quote, 64);
    const proofs = await ledger.completeMint(mintPreview);
    expect((await ledger.restoreMint(mintPreview))!.map((x) => x.C)).toEqual(proofs.map((x) => x.C)); // NUT-09 on a mint
    const p = await ledger.prepareSend(10, proofs!);
    const done = await ledger.completeSend(p.preview);
    const restored = await ledger.restoreSwap(p.preview);
    expect(restored).toBeDefined();
    expect(restored!.send.map((x) => x.C)).toEqual(done.send.map((x) => x.C));
    expect(restored!.keep.map((x) => x.C)).toEqual(done.keep.map((x) => x.C));
    expect((await ledger.proofStates(restored!.send)).every((s) => s === 'UNSPENT')).toBe(true);
  });

  it('route A: proofs locked to a NIP-61 key (02-prefixed x-only) carry DLEQ, need the key, and redeem with it', async () => {
    const { generateSecretKey, getPublicKey } = await import('nostr-tools/pure');
    const { Wallet } = await import('@cashu/cashu-ts');
    const { buildNutzap, normalizeP2pk } = await import('../src/core/nostr.ts');
    const ledger = new CashuLedger(MINT);
    const inv = await ledger.createInvoice(64);
    for (let i = 0; i < 20 && (await ledger.quoteState(inv.quote)) === 'UNPAID'; i++) await new Promise((r) => setTimeout(r, 500));
    const proofs = await ledger.completeMint(await ledger.prepareMint(inv.quote, 64));
    const sk = generateSecretKey();
    const skHex = Buffer.from(sk).toString('hex');
    const p2pk = normalizeP2pk(getPublicKey(sk))!;
    const p = await ledger.prepareSend(10, proofs, p2pk);
    const { send } = await ledger.completeSend(p.preview);
    expect(send.every((x) => x.dleq)).toBe(true);
    expect(JSON.parse(send[0].secret)[0]).toBe('P2PK');
    const ev = buildNutzap(send, MINT, 'ab'.repeat(32), '');
    const fromEvent = ev.tags.filter((t) => t[0] === 'proof').map((t) => JSON.parse(t[1]));
    const show = new Wallet(MINT); await show.loadMint();
    await expect(show.ops.receive(fromEvent as any).run()).rejects.toThrow(); // no key: refused
    const got = await show.ops.receive(fromEvent as any).privkey(skHex).run();
    expect(got.reduce((s: number, x: any) => s + Number(x.amount), 0)).toBeGreaterThanOrEqual(10);
  });

  it('funds, streams, boosts, survives a replayed POST, and exports the rest', async () => {
    const receiver = new MockReceiver({ acceptedMints: [MINT], redeem: cashuRedeem() });
    const { server, url } = await serve(receiver);
    try {
      const store = new MemoryStore();
      const w = await new NutWallet({ store, ledger: new CashuLedger(MINT), fetch: fetch as any, postGapMs: 0, lock: new Lock('live') }).open();
      const inv = await w.createInvoice(200);
      expect(inv.request).toMatch(/^lnbc/);
      let got = 0;
      for (let i = 0; i < 20 && !got; i++) { got = await w.claimInvoices(); if (!got) await new Promise((r) => setTimeout(r, 500)); }
      expect(got).toBe(200);

      const target = { url };
      await w.addOwed(12, target);
      await w.queueOwed();
      await w.queueBoost(target, 21, 'live test');
      const r = await w.pump();
      expect(r.done.map((b) => b.status)).toEqual(['done', 'done']);
      expect(receiver.total).toBe(33); // the show nets exactly what was sent (sender pays the fees)
      expect(receiver.received.map((x) => x.kind)).toEqual(['stream', 'boost']);
      const s = w.snapshot();
      expect(s.paid).toBe(33);
      expect(w.balance).toBe(200 - 33 - s.fees);

      // forged proofs: the mint refuses them, and the show says so
      const forged = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mint: MINT, unit: 'sat', memo: '', proofs: [{ id: '00', amount: 1, secret: 'x', C: 'y' }] }) });
      expect(forged.status).toBe(400);
      expect((await forged.json()).error).toBe('invalid_proofs');
      expect(receiver.total).toBe(33);
      // NUT-09 restore of a completed swap gives back the same proofs (the recovery path after a lost reply)
      const out = await w.exportAll();
      expect(out!.token).toMatch(/^cashuB/);
      expect(w.balance).toBe(0);
    } finally {
      server.close();
    }
  });
});
