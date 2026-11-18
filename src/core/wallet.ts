// The listener's wallet and payment outbox.
//
// Rules that keep money safe:
// - Every operation runs under one lock (Web Locks across tabs) and starts by reloading the state from the store,
//   so a second tab never works from a stale copy.
// - Every step saves its result before the next network call. A failed save aborts the operation; the next one
//   reloads the last saved state, so nothing half-done is ever written.
// - Bearer material is never deleted while it might still be needed: swap previews stay until their outputs are
//   in the wallet (replayed from the mint's cache, or restored with NUT-09 after it), exported tokens stay until
//   the user confirms, unpaid invoices stay until minted or expired.
//
// Outbox states:
//   new ──prepareSend──► prepared (inputs live only in the persisted swap preview)
//       ──completeSend──► ready (proofs for the show persisted; change back in the wallet)
//       ──POST──► done | returned (too small) | blocked (wrong mint) | failed (sender bug / cancelled) | retry later
import type { Ledger, ProofState } from './ledger.ts';
import { InsufficientFunds, PartialRestore } from './ledger.ts';
import { Lock, type Store } from './store.ts';
import { emptyState, normalizeState, sumProofs, isRouteA, targetKey, type Batch, type RouteATarget, type RouteBTarget, type Target, type WalletState, type WireProof } from './types.ts';
import { buildBody, postPayment, type FetchLike } from './routeB.ts';
import { buildNutzap, fetchNutzapInfo, normalizeP2pk, publishToRelays, sameMint, LOOKUP_RELAYS, type Publisher } from './nostr.ts';

export interface WalletOptions {
  store: Store;
  ledger: Ledger;
  fetch: FetchLike;
  /** Route A: publishes a signed kind:9321 to relays (default: real relays over WebSocket). */
  publish?: Publisher;
  /** Route A: re-reads a show's current kind:10019 before locking (default: public relays). */
  lookup?: (t: RouteATarget) => Promise<RouteATarget | undefined>;
  /** Route A: extra relays tried when the show's own relays keep refusing a nutzap. */
  fallbackRelays?: string[];
  now?: () => number;
  /** Minimum gap between POSTs to one endpoint host (the spec allows 10 per minute per IP). */
  postGapMs?: number;
  lock?: Lock;
}

export interface PumpReport { done: Batch[]; changed: Batch[]; }

/** A store write failed: the operation stops and its in-memory changes are discarded. */
export class SaveError extends Error {}

const RETRY_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
const PAUSE_MS = 30 * 60_000;
const QUOTE_TTL_MS = 24 * 3600_000;
const OPEN = ['new', 'prepared', 'ready'];
/** Route A: a silent nutzap under 100 sats counts as streaming at Sovereigncast; larger ones would be boosts. */
const ROUTE_A_STREAM_MAX = 99;
/** Route A: re-read the show's kind:10019 before locking when the snapshot is older than this. */
const NUTZAP_INFO_MAX_AGE_MS = 15 * 60_000;

export function validTarget(t: string | Target) {
  if (typeof t !== 'string' && isRouteA(t)) {
    return /^[0-9a-f]{64}$/.test(t.p) && !!normalizeP2pk(t.p2pk) && t.relays.length > 0 && t.relays.every((r) => /^wss:\/\//.test(r))
      && t.mints.length > 0 && t.mints.every((m) => /^https:\/\//.test(m));
  }
  const url = typeof t === 'string' ? t : t.url;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname); // local development only
}

export class NutWallet {
  private state!: WalletState;
  private readonly lock: Lock;
  private readonly now: () => number;
  private readonly postGapMs: number;
  private listeners = new Set<(s: WalletState) => void>();

  constructor(private opts: WalletOptions) {
    this.lock = opts.lock ?? new Lock();
    this.now = opts.now ?? Date.now;
    this.postGapMs = opts.postGapMs ?? 7_000;
  }

  get mintUrl() { return this.opts.ledger.mintUrl; }

  /** Load (or create) this mint's wallet. Refuses a store that holds another mint's wallet. */
  async open() {
    await this.lock.run(async () => {
      const saved = await this.opts.store.load();
      if (saved && saved.mint !== this.mintUrl) throw new Error(`this store holds the wallet for ${saved.mint}, not ${this.mintUrl}`);
      this.state = saved ? normalizeState(saved) : emptyState(this.mintUrl);
      if (!saved) await this.save();
    });
    return this;
  }

  /** Run `fn` under the lock on a fresh copy of the saved state. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return this.lock.run(async () => {
      const saved = await this.opts.store.load();
      if (!saved || saved.mint !== this.mintUrl) throw new Error('wallet store changed underneath us; reload the page');
      this.state = normalizeState(saved);
      return fn();
    });
  }

  private async save() {
    try { await this.opts.store.save(this.state); } catch (e: any) { throw new SaveError(`could not save the wallet: ${e?.message ?? e}`); }
    this.notify();
  }
  private notify() { const snap = this.snapshot(); for (const fn of this.listeners) { try { fn(snap); } catch { /* not ours */ } } }

  snapshot(): Readonly<WalletState> { return structuredClone(this.state); }
  get balance() { return sumProofs(this.state.proofs); }
  /** Sats in batches that have not settled yet (still ours until the show redeems them). */
  get inFlight() { return this.state.batches.filter((b) => OPEN.includes(b.status)).reduce((s, b) => s + b.amount, 0); }
  onChange(fn: (s: WalletState) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** Re-read the store (another tab may have changed it) and notify listeners. */
  async refresh() { await this.locked(async () => { this.notify(); }); }

  /** Drop proofs the mint says are spent (NUT-07). PENDING proofs are kept. Network errors are ignored. */
  async reconcile() {
    await this.locked(async () => {
      let states: ProofState[];
      try { states = await this.opts.ledger.proofStates(this.state.proofs); } catch { return; }
      const live = this.state.proofs.filter((_, i) => states[i] !== 'SPENT');
      if (live.length !== this.state.proofs.length) { this.state.proofs = live; await this.save(); }
    });
  }

  // --- funding ---

  /** Ask the mint for an invoice. The quote is saved, so a paid invoice is minted even after closing the tab. */
  async createInvoice(amount: number) {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a whole number of sats');
    const inv = await this.opts.ledger.createInvoice(amount);
    await this.locked(async () => {
      this.state.quotes.push({ quote: inv.quote, amount, request: inv.request, at: this.now() });
      await this.save();
    });
    return inv;
  }

  /**
   * Mint every paid invoice. The mint request is saved before it is sent, so a lost reply is replayed (NUT-19) or
   * restored (NUT-09); an issued quote is never dropped while its outputs are unaccounted for. Returns sats added.
   */
  async claimInvoices(): Promise<number> {
    return this.locked(async () => {
      let added = 0;
      for (const q of [...this.state.quotes]) {
        try {
          if (!q.preview) {
            const state = await this.opts.ledger.quoteState(q.quote);
            if (state === 'UNPAID') {
              if (this.now() - q.at > QUOTE_TTL_MS) { this.dropQuote(q.quote); await this.save(); }
              continue;
            }
            if (state === 'ISSUED') { this.dropQuote(q.quote); await this.save(); continue; } // minted elsewhere, before we asked
            q.preview = await this.opts.ledger.prepareMint(q.quote, q.amount);
            await this.save();
          }
          let proofs: WireProof[] | undefined;
          try {
            proofs = await this.opts.ledger.completeMint(q.preview);
          } catch (e) {
            if ((await this.opts.ledger.quoteState(q.quote)) !== 'ISSUED') throw e; // not minted yet: retry later
            proofs = await this.opts.ledger.restoreMint(q.preview); // minted, reply lost: get the signatures again
            if (!proofs) throw e;
          }
          this.state.proofs.push(...proofs);
          this.dropQuote(q.quote);
          added += sumProofs(proofs);
          await this.save();
        } catch (e) {
          if (e instanceof SaveError) throw e;
          // offline or mint busy: try again on the next call
        }
      }
      return added;
    });
  }
  private dropQuote(id: string) { this.state.quotes = this.state.quotes.filter((q) => q.quote !== id); }

  /** Receive a cashu token: the swap preview is saved first, so closing the tab mid-swap loses nothing. */
  async receiveToken(token: string | WireProof[]) {
    const prepared = await this.opts.ledger.prepareReceive(typeof token === 'string' ? token.trim() : token);
    return this.locked(async () => {
      const secrets = new Set(this.opts.ledger.previewInputs(prepared.preview).map((p) => p.secret));
      if (this.state.receives.some((r) => this.opts.ledger.previewInputs(r.preview).some((p) => secrets.has(p.secret)))) {
        throw new Error('this token is already being received; it finishes on its own');
      }
      const r = { id: `r${this.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, preview: prepared.preview, amount: prepared.amount, at: this.now() };
      this.state.receives.push(r);
      await this.save();
      const got = await this.finishReceive(r);
      if (got === 'gone') throw new Error('this token was already spent');
      return prepared.amount;
    });
  }

  /** Finish receives left over from an earlier visit. */
  async resumeReceives() {
    await this.locked(async () => {
      for (const r of [...this.state.receives]) { try { await this.finishReceive(r); } catch (e) { if (e instanceof SaveError) throw e; } }
    });
  }

  /**
   * Complete a saved receive. 'ok': proofs are in the wallet. 'gone': the inputs were spent by someone else (the
   * sender, or the show for a cancelled payment) and the entry is closed. Throws (entry kept) when it should retry.
   */
  private async finishReceive(r: WalletState['receives'][number]): Promise<'ok' | 'gone'> {
    let out: { keep: WireProof[]; send: WireProof[] } | undefined;
    try {
      out = await this.opts.ledger.completeSend(r.preview);
    } catch (e) {
      const states = await this.opts.ledger.proofStates(this.opts.ledger.previewInputs(r.preview));
      if (!states.every((s) => s === 'SPENT')) throw e; // not done yet: retry later
      out = await this.opts.ledger.restoreSwap(r.preview); // PartialRestore propagates: retry later
      if (!out) {
        // the inputs were spent, but not by this swap: close the entry
        this.state.receives = this.state.receives.filter((x) => x.id !== r.id);
        const b = r.cancelOf ? this.state.batches.find((x) => x.id === r.cancelOf) : undefined;
        if (b && b.status === 'ready') this.settle(b); // the show redeemed before the cancel: it was paid
        await this.save();
        return 'gone';
      }
    }
    this.state.proofs.push(...out.keep, ...out.send);
    this.state.receives = this.state.receives.filter((x) => x.id !== r.id);
    const b = r.cancelOf ? this.state.batches.find((x) => x.id === r.cancelOf) : undefined;
    if (b && b.status === 'ready') {
      this.state.fees += b.fee;
      b.send = undefined;
      b.status = 'failed';
      b.lastError = 'cancelled';
    }
    await this.save();
    return 'ok';
  }

  /**
   * Take everything out as one cashu token. The token is kept in the wallet state (and shown again) until the user
   * confirms they saved it with `clearExport()`, so a crash or a closed tab cannot lose it.
   */
  async exportAll(): Promise<{ token: string; amount: number } | undefined> {
    return this.locked(async () => {
      if (this.state.pendingExport) return this.state.pendingExport;
      const proofs = this.state.proofs;
      if (!proofs.length) return undefined;
      const token = this.opts.ledger.encodeToken(proofs, 'nutstream balance');
      this.state.pendingExport = { token, amount: sumProofs(proofs), at: this.now() };
      this.state.proofs = [];
      await this.save();
      return this.state.pendingExport;
    });
  }
  async clearExport() { await this.locked(async () => { this.state.pendingExport = undefined; await this.save(); }); }

  // --- metering hand-off ---

  /**
   * Remember metered sats for `target` that are not queued yet (survives closing the tab). Sats still owed to a
   * different show are queued for that show first, so they never go to the wrong one.
   */
  async addOwed(n: number, target: Target) {
    if (!Number.isInteger(n) || n <= 0) return;
    if (!validTarget(target)) throw new Error('payments go only to https endpoints or a valid nutzap target');
    await this.locked(async () => {
      if (this.state.owed > 0 && this.state.owedTarget && targetKey(this.state.owedTarget) !== targetKey(target)) this.queueOwedLocked();
      this.state.owed += n;
      this.state.owedTarget = target;
      await this.save();
    });
  }

  /** Queue everything owed as streaming payment(s) to the show it is owed to. Returns the batches created. */
  async queueOwed(): Promise<Batch[]> {
    return this.locked(async () => {
      const bs = this.queueOwedLocked();
      if (bs.length) await this.save();
      return bs;
    });
  }

  private queueOwedLocked(): Batch[] {
    let n = this.state.owed;
    const target = this.state.owedTarget;
    if (n <= 0 || !target) return [];
    this.state.owed = 0;
    // Route A: keep each streaming nutzap under the boost threshold
    const out: Batch[] = [];
    while (n > 0) {
      const part = isRouteA(target) ? Math.min(n, ROUTE_A_STREAM_MAX) : n;
      const b = this.newBatch('stream', part, '', target);
      this.state.batches.push(b);
      out.push(b);
      n -= part;
    }
    return out;
  }

  async queueBoost(target: Target, amount: number, memo: string) {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('boost amount must be a whole number of sats');
    if (!validTarget(target)) throw new Error('payments go only to https endpoints or a valid nutzap target');
    // Route A: a silent nutzap under 100 sats would be booked as streaming; a short note makes it a boost
    if (isRouteA(target) && amount < 100 && !memo.trim()) memo = 'boost';
    return this.locked(async () => {
      const b = this.newBatch('boost', amount, memo.slice(0, 500), target);
      this.state.batches.push(b);
      await this.save();
      return b;
    });
  }

  private newBatch(kind: Batch['kind'], amount: number, memo: string, target: Target): Batch {
    const t = this.now();
    return { id: `${t.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, kind, amount, memo, target, mint: this.mintUrl,
      status: 'new', fee: 0, attempts: 0, nextAt: t, createdAt: t };
  }

  /**
   * Stop a payment that has not settled. A queued one is dropped. A ready one is reclaimed by swapping its proofs
   * back to ourselves; if the show redeemed them first, it counts as paid.
   */
  async cancel(batchId: string) {
    return this.locked(async () => {
      const b = this.state.batches.find((x) => x.id === batchId);
      if (!b || !['new', 'ready'].includes(b.status)) return false;
      if (b.status === 'ready' && isRouteA(b.target)) return false; // locked to the show's key: they are the show's sats now
      if (b.status === 'new') {
        b.status = 'failed';
        b.lastError = 'cancelled';
        await this.save();
        return true;
      }
      if (this.state.receives.some((r) => r.cancelOf === b.id)) return false; // already cancelling
      const states = await this.opts.ledger.proofStates(b.send!);
      if (states.every((s) => s === 'SPENT')) { this.settle(b); await this.save(); return true; } // the show has it
      const prepared = await this.opts.ledger.prepareReceive(b.send!);
      const r = { id: `c${b.id}`, preview: prepared.preview, amount: prepared.amount, at: this.now(), cancelOf: b.id };
      this.state.receives.push(r);
      b.nextAt = this.now() + 24 * 3600_000; // no more POSTs while the reclaim is pending
      await this.save();
      try { await this.finishReceive(r); } catch (e) { if (e instanceof SaveError) throw e; } // retried on the next visit
      return true;
    });
  }

  // --- the outbox ---

  /** Move every due batch forward as far as it can go. Safe to call often and from several tabs. */
  async pump(): Promise<PumpReport> {
    return this.locked(async () => {
      const report: PumpReport = { done: [], changed: [] };
      for (const b of this.state.batches) {
        if (!OPEN.includes(b.status) || b.nextAt > this.now()) continue;
        const before = b.status;
        try {
          await this.advance(b);
        } catch (e: any) {
          if (e instanceof SaveError) throw e;
          b.lastError = `error: ${e?.message ?? e}`; // one bad batch never blocks the others
          b.nextAt = this.now() + this.backoff(b);
        }
        if (b.status !== before || b.lastError) report.changed.push(b);
        if (b.status === 'done') report.done.push(b);
      }
      this.pruneHistory();
      await this.save();
      return report;
    });
  }

  private async advance(b: Batch) {
    if (b.status === 'new') {
      if (isRouteA(b.target) && this.now() - (b.target.fetchedAt ?? 0) > NUTZAP_INFO_MAX_AGE_MS) {
        // the point of no return is next: lock only to the show's *current* key, mints and relays
        let fresh: RouteATarget | undefined;
        try { fresh = await (this.opts.lookup ?? ((t) => fetchNutzapInfo(t.p, [...new Set([...t.relays, ...LOOKUP_RELAYS])], 6000, t.label)))(b.target); } catch { fresh = undefined; }
        if (!fresh) { b.lastError = 'could not re-read the show\'s nutzap info (kind:10019); will retry'; b.nextAt = this.now() + this.backoff(b); return; }
        b.target = { ...fresh, label: b.target.label };
      }
      if (isRouteA(b.target) && !b.target.mints.some((m) => sameMint(m, b.mint))) {
        // the show cannot redeem proofs from this mint (NIP-61: sending on an unlisted mint burns the money)
        b.status = 'blocked';
        b.acceptedMints = b.target.mints;
        b.lastError = 'the show does not accept this mint';
        return;
      }
      let p;
      try {
        p = await this.opts.ledger.prepareSend(b.amount, this.state.proofs, isRouteA(b.target) ? b.target.p2pk : undefined);
        // Route A streaming: what the show sees is the proof total (amount + its redeem fee). Keep that under 100,
        // moving the excess into a new batch, so a streaming nutzap is never booked as a boost.
        for (let i = 0; isRouteA(b.target) && b.kind === 'stream' && p.sendTotal > ROUTE_A_STREAM_MAX && i < 3; i++) {
          const excess = p.sendTotal - ROUTE_A_STREAM_MAX;
          if (excess >= b.amount) break;
          b.amount -= excess;
          this.state.batches.push(this.newBatch('stream', excess, '', b.target));
          p = await this.opts.ledger.prepareSend(b.amount, this.state.proofs, b.target.p2pk);
        }
      } catch (e: any) {
        b.lastError = e instanceof InsufficientFunds ? 'insufficient-funds' : `prepare: ${e?.message ?? e}`;
        b.nextAt = this.now() + (e instanceof InsufficientFunds ? 15_000 : this.backoff(b));
        return;
      }
      b.swapPreview = p.preview;
      b.fee = p.fee;
      b.status = 'prepared';
      b.lastError = undefined;
      this.state.proofs = p.unselected; // the selected inputs now live only in the preview
      await this.save();
    }
    if (b.status === 'prepared') {
      let out: { keep: WireProof[]; send: WireProof[] } | undefined;
      try {
        out = await this.opts.ledger.completeSend(b.swapPreview!);
      } catch (e: any) {
        b.attempts++;
        b.lastError = `swap: ${e?.message ?? e}`;
        b.nextAt = this.now() + this.backoff(b);
        out = await this.recoverSwap(b);
        if (!out) return;
      }
      this.state.proofs.push(...out.keep);
      b.send = out.send;
      b.swapPreview = undefined;
      if (isRouteA(b.target)) {
        const mintAsListed = b.target.mints.find((m) => sameMint(m, b.mint))!; // the u tag must match the 10019 exactly
        b.event = JSON.stringify(buildNutzap(out.send, mintAsListed, b.target.p, b.memo, this.now()));
      }
      b.status = 'ready';
      b.attempts = 0;
      b.lastError = undefined;
      b.nextAt = this.now();
      await this.save();
    }
    if (b.status === 'ready' && isRouteA(b.target)) {
      // the proofs are locked to the show's key; publishing the saved event is all that is left (idempotent: same id)
      const wait = (this.state.lastPost['nostr'] ?? 0) + this.postGapMs - this.now();
      if (wait > 0) { b.nextAt = this.now() + wait; return; }
      this.state.lastPost['nostr'] = this.now();
      b.attempts++;
      if (!b.event) { // never expected: rebuild from the saved locked proofs rather than retrying a parse error forever
        const mintAsListed = b.target.mints.find((m) => sameMint(m, b.mint)) ?? b.mint;
        b.event = JSON.stringify(buildNutzap(b.send!, mintAsListed, b.target.p, b.memo, this.now()));
      }
      // after a few refusals, also try well-known relays: the show may read from them too
      const relays = b.attempts > 3 ? [...new Set([...b.target.relays, ...(this.opts.fallbackRelays ?? LOOKUP_RELAYS)])] : b.target.relays;
      const r = await (this.opts.publish ?? publishToRelays)(JSON.parse(b.event), relays);
      if (r.accepted > 0) return this.settle(b);
      b.lastError = `not delivered yet (the sats are locked to the show; no relay accepted the nutzap): ${r.errors.slice(0, 2).join('; ') || 'unknown'}`;
      b.nextAt = this.now() + this.backoff(b);
      return;
    }
    if (b.status === 'ready') {
      const target = b.target as RouteBTarget;
      const host = new URL(target.url).host;
      const wait = (this.state.lastPost[host] ?? 0) + this.postGapMs - this.now();
      if (wait > 0) { b.nextAt = this.now() + wait; return; }
      this.state.lastPost[host] = this.now();
      b.attempts++;
      const out = await postPayment(this.opts.fetch, target, b.kind, buildBody(target, b.mint, b.send!, b.memo));
      switch (out.kind) {
        case 'paid':
          return this.settle(b);
        case 'too-small':
          if ((await this.giveBack(b, 'returned', 'amount_too_small')) === 'all' && b.kind === 'stream') {
            if (this.state.owed > 0 && this.state.owedTarget && targetKey(this.state.owedTarget) !== targetKey(b.target)) this.queueOwedLocked();
            this.state.owed += b.amount;
            this.state.owedTarget = b.target;
          }
          return;
        case 'wrong-mint':
          b.acceptedMints = out.acceptedMints;
          await this.giveBack(b, 'blocked', out.error);
          return;
        case 'bug':
          await this.giveBack(b, 'failed', out.error);
          return;
        case 'pause':
          b.lastError = out.error;
          b.nextAt = this.now() + PAUSE_MS;
          return;
        case 'retry':
          b.lastError = out.error;
          b.nextAt = this.now() + this.backoff(b);
          return;
      }
    }
  }

  /**
   * The swap call failed. Look at the inputs:
   * - all spent: the mint did the swap and the reply was lost; get the outputs back with NUT-09 restore
   *   (the preview is kept until that works);
   * - all unspent after a few tries: the swap never happened; start over with fresh outputs;
   * - some unspent, none pending: not our swap (it spends all inputs or none); return the unspent ones, start over;
   * - pending, or the mint unreachable: wait.
   */
  private async recoverSwap(b: Batch): Promise<{ keep: WireProof[]; send: WireProof[] } | undefined> {
    const inputs = this.opts.ledger.previewInputs(b.swapPreview!);
    let states: ProofState[];
    try { states = await this.opts.ledger.proofStates(inputs); } catch { return undefined; }
    if (states.every((s) => s === 'SPENT')) {
      let restored;
      try {
        restored = await this.opts.ledger.restoreSwap(b.swapPreview!);
      } catch (e) {
        // mint unreachable, or only some signatures back: keep the preview and try again later
        b.lastError = e instanceof PartialRestore ? `restoring the outputs: ${e.message} (will retry)` : 'swap reply lost; restoring the outputs (will retry)';
        return undefined;
      }
      if (restored) return restored;
      // the mint signed none of our outputs: the inputs were spent by some other swap, not this one
      b.swapPreview = undefined;
      b.status = 'failed';
      b.lastError = 'its coins were spent elsewhere (another tab or wallet?); nothing was sent';
      return undefined;
    }
    if (states.includes('PENDING')) return undefined;
    const unspent = inputs.filter((_, i) => states[i] === 'UNSPENT');
    if (unspent.length === inputs.length && b.attempts < 3) return undefined;
    this.state.proofs.push(...unspent);
    b.swapPreview = undefined;
    b.fee = 0;
    b.status = 'new';
    b.attempts = 0;
    b.lastError = unspent.length === inputs.length ? 'swap restarted' : 'swap restarted; some inputs were already spent elsewhere';
    return undefined;
  }

  private settle(b: Batch) {
    // The sent proofs carry a little extra so the show can pay its own redeem fee: that is a fee too.
    if (b.send) b.fee += Math.max(0, sumProofs(b.send) - b.amount);
    b.status = 'done';
    b.doneAt = this.now();
    b.lastError = undefined;
    b.send = undefined;
    this.state.paid += b.amount;
    this.state.fees += b.fee;
  }

  /** The show did not take the proofs: put the unspent ones back. Says whether all, some or none came back. */
  private async giveBack(b: Batch, status: Batch['status'], error: string): Promise<'all' | 'some' | 'none'> {
    const proofs = b.send ?? [];
    let states: ProofState[];
    try { states = await this.opts.ledger.proofStates(proofs); } catch {
      b.lastError = `${error}; mint check failed, will retry`;
      b.nextAt = this.now() + this.backoff(b);
      return 'none';
    }
    if (proofs.length && states.every((s) => s === 'SPENT')) { this.settle(b); return 'none'; } // redeemed after all
    if (states.includes('PENDING')) { b.lastError = `${error}; proofs pending at the mint`; b.nextAt = this.now() + this.backoff(b); return 'none'; }
    const back = proofs.filter((_, i) => states[i] === 'UNSPENT');
    this.state.proofs.push(...back);
    this.state.fees += b.fee;
    b.send = undefined;
    b.status = status;
    b.lastError = error;
    return back.length === proofs.length ? 'all' : 'some';
  }

  private backoff(b: Batch) { return RETRY_MS[Math.min(b.attempts, RETRY_MS.length - 1)]; }

  /** Keep the last 50 settled batches for the history list; never drop unsettled ones. */
  private pruneHistory() {
    const settled = this.state.batches.filter((b) => !OPEN.includes(b.status));
    if (settled.length <= 50) return;
    const drop = new Set(settled.slice(0, settled.length - 50));
    this.state.batches = this.state.batches.filter((b) => !drop.has(b));
  }
}
