// Route B: pay a show over plain HTTPS with a NUT-18 payload (Nodesignal "Sovereigncast" CASHU_STREAMING.md).
// POST {id?, mint, unit, memo, proofs} to the endpoint; `?action=stream` books it as streaming, without it a boost.
import type { RouteBTarget, WireProof } from './types.ts';

export type PostOutcome =
  | { kind: 'paid'; amount?: number } // success, already_redeemed, already_spent
  | { kind: 'too-small' } // amount_too_small: keep and send with the next batch
  | { kind: 'wrong-mint'; error: string; acceptedMints: string[] } // untrusted_mint / unsupported_mint
  | { kind: 'pause'; error: string } // disabled / unavailable: stop for a while
  | { kind: 'bug'; error: string } // invalid_payload / unsupported_unit: never retry unchanged
  | { kind: 'retry'; error: string }; // anything else, any 5xx, network errors: hold the proofs, retry later

export interface PaymentBody {
  id?: string;
  mint: string;
  unit: 'sat';
  memo: string;
  proofs: WireProof[];
}

export function buildBody(target: RouteBTarget, mint: string, proofs: WireProof[], memo = ''): PaymentBody {
  const body: PaymentBody = { mint, unit: 'sat', memo, proofs: proofs.map((p) => ({ ...p, amount: Number(p.amount) })) };
  return target.requestId ? { id: target.requestId, ...body } : body;
}

export function endpointUrl(target: RouteBTarget, kind: 'stream' | 'boost') {
  const u = new URL(target.url);
  if (kind === 'stream') u.searchParams.set('action', 'stream');
  else u.searchParams.delete('action');
  return u.toString();
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
  Promise<{ status: number; text(): Promise<string> }>;

export async function postPayment(fetchFn: FetchLike, target: RouteBTarget, kind: 'stream' | 'boost', body: PaymentBody): Promise<PostOutcome> {
  let status: number, text: string;
  try {
    const res = await fetchFn(endpointUrl(target, kind), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000), // a show that never answers must not hold the wallet lock
    });
    status = res.status;
    text = await res.text();
  } catch (e: any) {
    return { kind: 'retry', error: `network: ${e?.message ?? e}` };
  }
  return classify(status, text);
}

export function classify(status: number, text: string): PostOutcome {
  let json: any;
  try { json = JSON.parse(text); } catch { json = undefined; }
  if (status >= 200 && status < 300 && json?.success === true) {
    return { kind: 'paid', amount: typeof json.amount_sats === 'number' ? json.amount_sats : undefined };
  }
  const error: string = typeof json?.error === 'string' ? json.error : `http ${status}`;
  // Any 5xx is retryable except the two "stop for a while" answers the spec gives with 503.
  if (status >= 500 && error !== 'disabled' && error !== 'unavailable') return { kind: 'retry', error };
  switch (error) {
    case 'already_redeemed':
    case 'already_spent':
      return { kind: 'paid' };
    case 'amount_too_small':
      return { kind: 'too-small' };
    case 'untrusted_mint':
    case 'unsupported_mint':
      return { kind: 'wrong-mint', error, acceptedMints: Array.isArray(json?.accepted_mints) ? json.accepted_mints.filter((m: unknown) => typeof m === 'string') : [] };
    case 'disabled':
    case 'unavailable':
      return { kind: 'pause', error };
    case 'invalid_payload':
    case 'unsupported_unit':
      return { kind: 'bug', error };
    default:
      return { kind: 'retry', error };
  }
}
