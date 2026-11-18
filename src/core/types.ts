// Shared shapes. Proofs are stored and sent in "wire" form: amount is a plain number, the rest exactly as issued.

export interface WireProof {
  id: string;
  amount: number;
  secret: string;
  C: string;
  dleq?: { e: string; s: string; r?: string };
  witness?: string;
}

/** Route B: a NUT-18 HTTP POST endpoint (private). */
export interface RouteBTarget {
  route?: 'B';
  url: string;
  /** The `id` of the payment request (creq), when the feed's request had one. */
  requestId?: string;
  /** Show name, for the UI only. */
  label?: string;
}

/** Route A: NIP-61 nutzaps to the show's kind:10019 (public kind:9321 events). */
export interface RouteATarget {
  route: 'A';
  /** The show's Nostr pubkey (hex). */
  p: string;
  /** The P2PK key its wallet receives with (02-prefixed). */
  p2pk: string;
  mints: string[];
  relays: string[];
  label?: string;
  /** When this kind:10019 snapshot was read (ms). Refreshed before locking if it is old. */
  fetchedAt?: number;
}

export type Target = RouteBTarget | RouteATarget;
export const isRouteA = (t: Target): t is RouteATarget => t.route === 'A';
/** Identity of a payee, to keep sats owed to one show from going to another. */
export const targetKey = (t: Target) => (isRouteA(t) ? `nostr:${t.p}` : t.url);

export type BatchStatus =
  | 'new' // queued; no proofs chosen yet
  | 'prepared' // swap preview persisted (holds the input proofs); swap not confirmed yet
  | 'ready' // swap done; `send` holds the proofs for the show
  | 'done' // the show confirmed (or the proofs were already redeemed)
  | 'returned' // proofs came back to the wallet (amount too small); amount added back to `owed`
  | 'blocked' // the show refused this mint; proofs back in the wallet
  | 'failed'; // a sender bug (invalid payload); proofs back in the wallet

export interface Batch {
  id: string;
  kind: 'stream' | 'boost';
  amount: number; // sats the show should receive
  memo: string;
  target: Target;
  mint: string;
  /** Route A: the signed kind:9321 (JSON), saved before it is published so a retry sends the identical event. */
  event?: string;
  status: BatchStatus;
  /** Serialized swap preview: spendable bearer material until the swap settles. */
  swapPreview?: string;
  send?: WireProof[];
  fee: number; // input fee paid on our swap
  attempts: number;
  nextAt: number; // ms epoch: not before
  lastError?: string;
  acceptedMints?: string[];
  createdAt: number;
  doneAt?: number;
}

export interface WalletState {
  v: 1;
  mint: string;
  proofs: WireProof[];
  batches: Batch[];
  /** Sats metered but not yet queued (survives page close), and the show they are owed to. */
  owed: number;
  owedTarget?: Target;
  /** Totals, for the UI. */
  paid: number;
  fees: number;
  /** Lightning invoices we asked the mint for and have not minted yet (survive closing the tab). */
  quotes: { quote: string; amount: number; request: string; at: number; preview?: string }[];
  /** Incoming tokens whose swap preview is saved but not confirmed yet. */
  receives: { id: string; preview: string; amount: number; at: number; cancelOf?: string }[];
  /** The last exported token: kept until the user confirms they saved it. */
  pendingExport?: { token: string; amount: number; at: number };
  /** Last POST per endpoint host (rate limit), shared by every tab. */
  lastPost: Record<string, number>;
}

export const emptyState = (mint: string): WalletState =>
  ({ v: 1, mint, proofs: [], batches: [], owed: 0, paid: 0, fees: 0, quotes: [], receives: [], lastPost: {} });

/** Fill fields added after a state was first saved. */
export const normalizeState = (s: WalletState): WalletState => ({ ...emptyState(s.mint), ...s });

export const sumProofs = (ps: readonly { amount: unknown }[]) => ps.reduce((s, p) => s + amountToNumber(p.amount), 0);

/** cashu-ts 4 returns `Amount` objects; everything we store or send uses plain numbers. */
export function amountToNumber(a: unknown): number {
  if (typeof a === 'number') return a;
  if (typeof a === 'bigint') return Number(a);
  if (typeof a === 'string') return Number(a);
  if (a && typeof (a as any).toNumber === 'function') return (a as any).toNumber();
  throw new Error(`not an amount: ${String(a)}`);
}

export function toWire(p: any): WireProof {
  const w: WireProof = { id: p.id, amount: amountToNumber(p.amount), secret: p.secret, C: p.C };
  if (p.dleq) w.dleq = { e: p.dleq.e, s: p.dleq.s, ...(p.dleq.r ? { r: p.dleq.r } : {}) };
  if (p.witness) w.witness = typeof p.witness === 'string' ? p.witness : JSON.stringify(p.witness);
  return w;
}
