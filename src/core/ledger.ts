// The mint operations nutstream needs, behind a small interface so the outbox can be tested with a fake mint.
import {
  Wallet, MintQuoteState, CheckStateEnum, getEncodedToken, getDecodedToken, OutputData, Amount,
  serializeSwapPreview, deserializeSwapPreview, setGlobalRequestOptions,
} from '@cashu/cashu-ts';
import { amountToNumber, toWire, sumProofs, type WireProof } from './types.ts';

export interface PreparedSend {
  /** Serialized swap preview (spendable; persist before completing). */
  preview: string;
  /** Proofs not used by the swap: they go straight back to the wallet. */
  unselected: WireProof[];
  fee: number;
}

export type ProofState = 'UNSPENT' | 'PENDING' | 'SPENT';

export interface Ledger {
  readonly mintUrl: string;
  /** Pick inputs for `amount` (plus fees, so the receiver nets `amount`). Throws InsufficientFunds. */
  prepareSend(amount: number, proofs: WireProof[]): Promise<PreparedSend>;
  /** Run (or replay) a persisted swap. Replaying the same preview is safe inside the mint's NUT-19 window. */
  completeSend(preview: string): Promise<{ keep: WireProof[]; send: WireProof[] }>;
  /**
   * After the swap happened but its reply was lost (and the cache window passed): ask the mint for the signatures
   * of the preview's outputs again (NUT-09 restore) and rebuild the proofs. Undefined if the mint has none.
   */
  restoreSwap(preview: string): Promise<{ keep: WireProof[]; send: WireProof[] } | undefined>;
  /** The input proofs held by a serialized swap preview. */
  previewInputs(preview: string): WireProof[];
  proofStates(proofs: WireProof[]): Promise<ProofState[]>;
  /** Prepare swapping someone's token into fresh proofs we own (persist the preview, then complete it). */
  prepareReceive(token: string | WireProof[]): Promise<{ preview: string; amount: number }>;
  createInvoice(amount: number): Promise<{ quote: string; request: string }>;
  quoteState(quote: string): Promise<'UNPAID' | 'PAID' | 'ISSUED'>;
  /** Build the mint request for a paid quote (persist it, then complete it). */
  prepareMint(quote: string, amount: number): Promise<string>;
  /** Send (or replay) a persisted mint request. */
  completeMint(preview: string): Promise<WireProof[]>;
  /** The mint issued but the reply was lost: get the signatures again (NUT-09). Undefined if the mint has none. */
  restoreMint(preview: string): Promise<WireProof[] | undefined>;
  encodeToken(proofs: WireProof[], memo?: string): string;
}

// Mint calls run while the wallet lock is held: a mint that stops answering must fail fast (default is 5 minutes).
// On the mint's cached endpoints (NUT-19) a timeout becomes a safe retry of the same request.
setGlobalRequestOptions({ requestTimeout: 20_000 });

export class InsufficientFunds extends Error {
  constructor(public need: number, public have: number) { super(`need ${need} sats, wallet has ${have}`); }
}
export class QuoteIssued extends Error {}
/** The mint signed only some of the outputs we asked about: retry later. */
export class PartialRestore extends Error {}

// Mint previews hold bigint and byte values; store them as hex.
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
// Amount objects serialize to strings in JSON; the mint wants plain numbers, so convert before stringifying.
const jsonSafe = (v: any): any => {
  if (typeof v === 'bigint') return Number(v);
  if (v && typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === 'object' && !(v instanceof Uint8Array)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  return v;
};
interface StoredMint { quote: string; amount: number; payload: any; keysetId: string; outputs: { b: any; r: string; s: string }[] }

export class CashuLedger implements Ledger {
  private wallet: Wallet;
  private loading?: Promise<void>;
  constructor(public readonly mintUrl: string) {
    this.wallet = new Wallet(mintUrl, { unit: 'sat' });
  }

  /** Load the mint lazily; a failure (offline) is retried on the next call instead of sticking. */
  private ensure() {
    if (!this.loading) this.loading = this.wallet.loadMint().catch((e) => { this.loading = undefined; throw e; });
    return this.loading;
  }

  async prepareSend(amount: number, proofs: WireProof[]): Promise<PreparedSend> {
    await this.ensure();
    const have = sumProofs(proofs);
    if (have < amount) throw new InsufficientFunds(amount, have);
    let preview;
    try {
      preview = await this.wallet.ops.send(amount, proofs as any).includeFees(true).prepare();
    } catch (e: any) {
      if (/not enough|insufficient/i.test(String(e?.message))) throw new InsufficientFunds(amount, have);
      throw e;
    }
    return {
      preview: JSON.stringify(serializeSwapPreview(preview)),
      unselected: (preview.unselectedProofs ?? []).map(toWire),
      fee: amountToNumber(preview.fees ?? 0),
    };
  }

  async completeSend(preview: string) {
    await this.ensure();
    const { keep, send } = await this.wallet.completeSwap(deserializeSwapPreview(JSON.parse(preview)));
    return { keep: keep.map(toWire), send: send.map(toWire) };
  }

  async restoreSwap(preview: string) {
    await this.ensure();
    const p = deserializeSwapPreview(JSON.parse(preview));
    const outs = [...(p.sendOutputs ?? []).map((o) => ({ o, send: true })), ...(p.keepOutputs ?? []).map((o) => ({ o, send: false }))];
    const proofs = await this.restoreOutputs(outs.map(({ o }) => o));
    if (!proofs) return undefined;
    return { send: proofs.filter((_, i) => outs[i].send), keep: proofs.filter((_, i) => !outs[i].send) };
  }

  /**
   * NUT-09: ask the mint for the signatures of these outputs and rebuild the proofs (in the same order).
   * Undefined if it signed none of them (not our swap/mint); PartialRestore if only some.
   */
  private async restoreOutputs(outs: { blindedMessage: { B_: string }; toProof(sig: any, keyset: any): any }[]) {
    if (!outs.length) return undefined;
    const res = await this.wallet.mint.restore({ outputs: outs.map((o) => o.blindedMessage) as any });
    const sigByB = new Map(res.outputs.map((m, i) => [m.B_, res.signatures[i]]));
    const found = outs.filter((o) => sigByB.has(o.blindedMessage.B_)).length;
    if (found === 0) return undefined;
    if (found < outs.length) throw new PartialRestore(`the mint returned ${found} of ${outs.length} signatures`);
    const proofs: WireProof[] = [];
    for (const o of outs) {
      const sig = sigByB.get(o.blindedMessage.B_)!;
      const keyset = await this.wallet.keyChain.ensureKeysetKeys(sig.id); // also loads keys of a rotated-out keyset
      proofs.push(toWire(o.toProof(sig, keyset)));
    }
    return proofs;
  }

  previewInputs(preview: string) {
    return deserializeSwapPreview(JSON.parse(preview)).inputs.map(toWire);
  }

  async proofStates(proofs: WireProof[]): Promise<ProofState[]> {
    if (!proofs.length) return [];
    await this.ensure();
    const states = await this.wallet.checkProofsStates(proofs as any);
    return proofs.map((_, i) => {
      const s = states[i]?.state;
      return s === CheckStateEnum.UNSPENT ? 'UNSPENT' : s === CheckStateEnum.PENDING ? 'PENDING' : 'SPENT';
    });
  }

  async prepareReceive(token: string | WireProof[]) {
    await this.ensure();
    const input = typeof token === 'string' ? getDecodedToken(token, this.wallet.keyChain.getAllKeysetIds()) : (token as any);
    if (typeof token === 'string' && input.mint && input.mint.replace(/\/+$/, '') !== this.mintUrl.replace(/\/+$/, '')) {
      throw new Error(`this token is from ${input.mint}; switch the wallet to that mint to receive it`);
    }
    const preview = await this.wallet.ops.receive(input).prepare();
    return { preview: JSON.stringify(serializeSwapPreview(preview)), amount: amountToNumber(preview.amount) };
  }

  async createInvoice(amount: number) {
    await this.ensure();
    const q = await this.wallet.createMintQuoteBolt11(amount);
    return { quote: q.quote, request: q.request };
  }

  async quoteState(quote: string) {
    await this.ensure();
    const q = await this.wallet.checkMintQuoteBolt11(quote);
    return q.state === MintQuoteState.UNPAID ? 'UNPAID' : q.state === MintQuoteState.ISSUED ? 'ISSUED' : 'PAID';
  }

  async prepareMint(quote: string, amount: number) {
    await this.ensure();
    const p = await this.wallet.ops.mintBolt11(amount, quote).prepare();
    const stored: StoredMint = {
      quote, amount, payload: jsonSafe(p.payload), keysetId: p.keysetId,
      outputs: p.outputData.map((o: any) => ({ b: jsonSafe(o.blindedMessage), r: o.blindingFactor.toString(16), s: hex(o.secret) })),
    };
    return JSON.stringify(stored);
  }

  private mintOutputs(s: StoredMint) {
    return s.outputs.map((o) => new OutputData({ ...o.b, amount: Amount.from(o.b.amount) }, BigInt(`0x${o.r}`), unhex(o.s)));
  }

  async completeMint(preview: string) {
    await this.ensure();
    const s = JSON.parse(preview) as StoredMint;
    const proofs = await this.wallet.completeMint({
      method: 'bolt11', payload: s.payload, outputData: this.mintOutputs(s), keysetId: s.keysetId, quote: { quote: s.quote },
    } as any);
    return proofs.map(toWire);
  }

  async restoreMint(preview: string) {
    await this.ensure();
    return this.restoreOutputs(this.mintOutputs(JSON.parse(preview) as StoredMint) as any);
  }

  encodeToken(proofs: WireProof[], memo?: string) {
    return getEncodedToken({ mint: this.mintUrl, unit: 'sat', proofs: proofs as any, ...(memo ? { memo } : {}) });
  }
}
