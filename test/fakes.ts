// A deterministic fake mint for outbox tests: proofs are numbered, the mint tracks spent secrets and caches swap
// replies (like NUT-19), and failures can be injected at each step.
import type { Ledger, PreparedSend } from '../src/core/ledger.ts';
import { InsufficientFunds } from '../src/core/ledger.ts';
import { sumProofs, type WireProof } from '../src/core/types.ts';

export const MINT = 'https://mint.test';
let n = 0;
export const proof = (amount: number): WireProof => ({ id: '00test', amount, secret: `s${++n}`, C: `c${n}` });

export class FakeLedger implements Ledger {
  readonly mintUrl = MINT;
  spent = new Set<string>();
  swapCache = new Map<string, { keep: WireProof[]; send: WireProof[] }>();
  failSwap = 0; // throw before the swap reaches the mint
  loseSwapReply = 0; // the mint does the swap, the reply is lost
  cacheWorks = true;
  swaps = 0;

  fee(inputs: number) { return Math.ceil((inputs * 100) / 1000); }

  lastP2pk?: string;
  /** Simulates includeFees on a fee-charging mint: the show's redeem fee is added to what it receives. */
  receiverFee = 0;
  async prepareSend(amount: number, proofs: WireProof[], p2pk?: string): Promise<PreparedSend> {
    this.lastP2pk = p2pk;
    const sorted = [...proofs].sort((a, b) => b.amount - a.amount);
    const chosen: WireProof[] = [];
    for (const p of sorted) {
      if (sumProofs(chosen) >= amount + this.fee(chosen.length)) break;
      chosen.push(p);
    }
    const fee = this.fee(chosen.length);
    if (sumProofs(chosen) < amount + fee) throw new InsufficientFunds(amount + fee, sumProofs(proofs));
    const unselected = proofs.filter((p) => !chosen.includes(p));
    return { preview: JSON.stringify({ key: `swap${++n}`, inputs: chosen, amount, fee }), unselected, fee, sendTotal: amount + this.receiverFee };
  }

  previewInputs(preview: string) { return JSON.parse(preview).inputs as WireProof[]; }

  async completeSend(preview: string) {
    const { key, inputs, amount, fee } = JSON.parse(preview) as { key: string; inputs: WireProof[]; amount: number; fee: number };
    if (this.failSwap > 0) { this.failSwap--; throw new Error('network down'); }
    const cached = this.swapCache.get(key);
    if (cached) {
      if (!this.cacheWorks) throw new Error('Token Already Spent');
      return cached;
    }
    if (inputs.some((p) => this.spent.has(p.secret))) throw new Error('Token Already Spent');
    for (const p of inputs) this.spent.add(p.secret);
    this.swaps++;
    const change = sumProofs(inputs) - amount - fee;
    const out = { send: [proof(amount)], keep: change > 0 ? [proof(change)] : [] };
    this.swapCache.set(key, out);
    if (this.loseSwapReply > 0) { this.loseSwapReply--; throw new Error('connection reset'); }
    return out;
  }

  restoreWorks = true;
  stateCheckWorks = true;
  paidQuotes = new Set<string>();
  issuedQuotes = new Set<string>();

  async proofStates(proofs: WireProof[]) {
    if (!this.stateCheckWorks) throw new Error('mint unreachable');
    return proofs.map((p) => (this.spent.has(p.secret) ? 'SPENT' as const : 'UNSPENT' as const));
  }
  /** NUT-09: the mint still knows the signatures for outputs it signed, whatever the cache window. */
  async restoreSwap(preview: string) {
    if (!this.restoreWorks) throw new Error('mint unreachable');
    return this.swapCache.get(JSON.parse(preview).key);
  }
  // like cashu-ts: preparing a receive is local and does not ask the mint whether the proofs are spent
  async prepareReceive(token: string | WireProof[]) {
    const proofs = token as WireProof[];
    const amount = sumProofs(proofs);
    return { preview: JSON.stringify({ key: `swap${++n}`, inputs: proofs, amount, fee: 0 }), amount };
  }
  loseMintReply = 0;
  mintCache = new Map<string, WireProof[]>();
  async createInvoice(amount: number) { const quote = `q${++n}`; return { quote, request: `lnbc${amount}` }; }
  async quoteState(quote: string) { return this.issuedQuotes.has(quote) ? 'ISSUED' as const : this.paidQuotes.has(quote) ? 'PAID' as const : 'UNPAID' as const; }
  async prepareMint(quote: string, amount: number) { return JSON.stringify({ quote, amount }); }
  async completeMint(preview: string) {
    const { quote, amount } = JSON.parse(preview);
    if (this.issuedQuotes.has(quote)) {
      if (this.cacheWorks && this.mintCache.has(quote)) return this.mintCache.get(quote)!;
      throw new Error('quote already issued');
    }
    if (!this.paidQuotes.has(quote)) throw new Error('quote not paid');
    this.issuedQuotes.add(quote);
    const out = [proof(amount)];
    this.mintCache.set(quote, out);
    if (this.loseMintReply > 0) { this.loseMintReply--; throw new Error('connection reset'); }
    return out;
  }
  async restoreMint(preview: string) {
    if (!this.restoreWorks) throw new Error('mint unreachable');
    return this.mintCache.get(JSON.parse(preview).quote);
  }
  encodeToken(proofs: WireProof[]) { return `cashuBfake${sumProofs(proofs)}`; }

  /** What a show's server does: swap the proofs (here: mark them spent). */
  redeem = async (_mint: string, proofs: WireProof[]) => {
    if (proofs.some((p) => this.spent.has(p.secret))) return { spent: true as const };
    for (const p of proofs) this.spent.add(p.secret);
    return { amount: sumProofs(proofs) };
  };
}
