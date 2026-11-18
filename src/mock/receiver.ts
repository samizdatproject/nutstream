// A stand-in for a show's Route B endpoint, written only from the spec's reply table. It redeems the proofs at the
// mint for real, so "already spent" comes from the mint, not from a flag. Used by the tests (over HTTP) and by the
// demo page (in the browser, as the "demo show").
import type { FetchLike } from '../core/routeB.ts';
import type { WireProof } from '../core/types.ts';

export type Redeem = (mint: string, proofs: WireProof[]) => Promise<{ amount: number } | { spent: true } | { invalid: string }>;

export interface ReceiverOptions {
  acceptedMints: string[];
  redeem: Redeem;
  minSats?: number; // smaller payments get amount_too_small
  perMinute?: number; // rate limit per client (spec: 10)
  now?: () => number;
  /** Simulate the show being switched off. */
  disabled?: boolean;
}

export interface Received { at: number; kind: 'stream' | 'boost'; amount: number; mint: string; memo: string; }

export interface MockRequest { method: string; url: string; body?: string; client?: string; }
export interface MockResponse { status: number; headers: Record<string, string>; body: string; }

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type',
};

export class MockReceiver {
  readonly received: Received[] = [];
  private seen = new Set<string>(); // secrets this "show" already booked
  private hits = new Map<string, number[]>();
  private listeners = new Set<(r: Received) => void>();

  constructor(public opts: ReceiverOptions) {}

  onReceive(fn: (r: Received) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  get total() { return this.received.reduce((s, r) => s + r.amount, 0); }

  async handle(req: MockRequest): Promise<MockResponse> {
    const reply = (status: number, json: unknown): MockResponse =>
      ({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(json) });
    if (req.method === 'OPTIONS') return { status: 204, headers: CORS, body: '' };
    if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });

    const now = (this.opts.now ?? Date.now)();
    const client = req.client ?? 'local';
    const recent = (this.hits.get(client) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= (this.opts.perMinute ?? 10)) return reply(429, { error: 'rate_limited' });
    recent.push(now);
    this.hits.set(client, recent);

    if (this.opts.disabled) return reply(503, { error: 'disabled' });

    let body: any;
    try { body = JSON.parse(req.body ?? ''); } catch { return reply(400, { error: 'invalid_payload' }); }
    if (!body || typeof body.mint !== 'string' || !Array.isArray(body.proofs) || body.proofs.length === 0 ||
        !body.proofs.every(validProof) || (body.memo !== undefined && typeof body.memo !== 'string')) {
      return reply(400, { error: 'invalid_payload' });
    }
    if (body.unit !== 'sat') return reply(400, { error: 'unsupported_unit' });
    const mint = String(body.mint).replace(/\/+$/, '');
    if (!this.opts.acceptedMints.map((m) => m.replace(/\/+$/, '')).includes(mint)) {
      return reply(400, { error: 'untrusted_mint', accepted_mints: this.opts.acceptedMints });
    }
    const proofs = body.proofs as WireProof[];
    if (proofs.some((p) => this.seen.has(p.secret))) return reply(409, { error: 'already_redeemed' });
    const amount = proofs.reduce((s, p) => s + p.amount, 0);
    if (amount < (this.opts.minSats ?? 1)) return reply(400, { error: 'amount_too_small' });

    let result;
    try { result = await this.opts.redeem(mint, proofs); } catch { return reply(400, { error: 'unsupported_mint' }); } // mint unreachable
    if ('spent' in result) return reply(400, { error: 'already_spent' });
    if ('invalid' in result) return reply(400, { error: 'invalid_proofs', detail: result.invalid });
    for (const p of proofs) this.seen.add(p.secret);
    const kind = new URL(req.url, 'http://x').searchParams.get('action') === 'stream' ? 'stream' : 'boost';
    const r: Received = { at: now, kind, amount: result.amount, mint, memo: typeof body.memo === 'string' ? body.memo : '' };
    this.received.push(r);
    for (const fn of this.listeners) { try { fn(r); } catch { /* ignore */ } }
    return reply(200, { success: true, amount_sats: result.amount, mint_url: mint });
  }

  /** A fetch function that talks to this receiver in-process (the demo page uses it; no network). */
  asFetch(client = 'demo'): FetchLike {
    return async (url, init) => {
      const res = await this.handle({ method: init.method, url, body: init.body, client });
      return { status: res.status, text: async () => res.body };
    };
  }
}

function validProof(p: any) {
  return p && typeof p.id === 'string' && typeof p.secret === 'string' && typeof p.C === 'string' &&
    typeof p.amount === 'number' && Number.isInteger(p.amount) && p.amount > 0;
}
