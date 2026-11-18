// A stand-in for a show receiving NIP-61 nutzaps (route A), for the demo page: it plays the relay and the show's
// wallet in one. It checks the event, redeems the P2PK-locked proofs with the show's key at the mint, and records
// the payment the way Sovereigncast classifies it (a message, or 100 sats or more, is a boost).
import { verifyEvent, type Event } from 'nostr-tools/pure';
import type { Received } from './receiver.ts';
import type { Redeem } from './receiver.ts';
import type { Publisher } from '../core/nostr.ts';
import { sameMint } from '../core/nostr.ts';

export class MockNutzapShow {
  readonly received: Received[] = [];
  private listeners = new Set<(r: Received) => void>();
  private seen = new Set<string>();
  constructor(private opts: { showHex: string; mints: string[]; redeem: Redeem }) {}
  onReceive(fn: (r: Received) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  readonly publish: Publisher = async (ev: Event) => {
    if (this.seen.has(ev.id)) return { accepted: 1, errors: [] }; // a relay answers "duplicate"
    if (!verifyEvent(ev)) return { accepted: 0, errors: ['invalid signature'] }; // the only thing a relay checks
    this.seen.add(ev.id);
    // like a real relay: accept the event; the show's wallet then finds out whether it can redeem it
    const unredeemable = (why: string) => {
      const rec: Received = { at: Date.now(), kind: 'boost', amount: 0, mint: '', memo: `UNREDEEMABLE: ${why}` };
      this.received.push(rec);
      for (const fn of this.listeners) { try { fn(rec); } catch { /* */ } }
      return { accepted: 1, errors: [] };
    };
    if (ev.kind !== 9321) return { accepted: 1, errors: [] };
    if (!ev.tags.some((t) => t[0] === 'p' && t[1] === this.opts.showHex)) return { accepted: 1, errors: [] }; // for someone else
    const mint = ev.tags.find((t) => t[0] === 'u')?.[1] ?? '';
    if (!this.opts.mints.some((m) => m === mint)) return unredeemable('mint not listed exactly');
    let proofs;
    try { proofs = ev.tags.filter((t) => t[0] === 'proof').map((t) => JSON.parse(t[1])); } catch { return unredeemable('bad proof tag'); }
    if (!proofs.length || proofs.some((p) => !p.dleq)) return unredeemable('proofs without DLEQ');
    try {
      const r = await this.opts.redeem(mint.replace(/\/+$/, ''), proofs);
      if ('amount' in r) {
        const total = proofs.reduce((s: number, p: any) => s + p.amount, 0);
        const rec: Received = { at: Date.now(), kind: ev.content || total >= 100 ? 'boost' : 'stream', amount: r.amount, mint, memo: ev.content };
        this.received.push(rec);
        for (const fn of this.listeners) { try { fn(rec); } catch { /* */ } }
      }
    } catch { /* the relay accepted the event even if the wallet redeems later */ }
    return { accepted: 1, errors: [] };
  };
}

export { sameMint };
