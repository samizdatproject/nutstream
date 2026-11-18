// Route A: NIP-61 nutzaps. The show's kind:10019 lists the relays it reads, the mints it accepts and the P2PK key
// its wallet uses; we lock proofs to that key and publish a kind:9321 to those relays.
// Every nutzap is signed with a fresh throwaway key, so a listener's payments are not linkable to each other
// (the events are still public: Route B is the private route).
import { finalizeEvent, generateSecretKey, verifyEvent, type Event } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import type { RouteATarget, WireProof } from './types.ts';

export const LOOKUP_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.band'];

export function npubToHex(npub: string): string {
  const d = nip19.decode(npub.trim());
  if (d.type !== 'npub') throw new Error('not an npub');
  return d.data as string;
}

/** NIP-61: the P2PK lock key is a secp256k1 key; nostr<>cashu compatibility requires the "02" prefix. */
export function normalizeP2pk(pk: string): string | undefined {
  const k = pk.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(k)) return `02${k}`;
  if (/^0[23][0-9a-f]{64}$/.test(k)) return `02${k.slice(2)}`; // same x-only (Schnorr) key, the prefix NIP-61 requires
  return undefined;
}

export const sameMint = (a: string, b: string) => a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '');

/** Read a kind:10019 event into a Route A target (undefined if it is unusable). */
export function parseNutzapInfo(ev: Pick<Event, 'tags'>, recipientHex: string, label?: string): RouteATarget | undefined {
  const relays = ev.tags.filter((t) => t[0] === 'relay' && /^wss:\/\//.test(t[1] ?? '')).map((t) => t[1].replace(/\/+$/, '')).slice(0, 8);
  // a mint with a unit list must include sat; one without units is taken as sat
  const mints = ev.tags.filter((t) => t[0] === 'mint' && /^https:\/\//.test(t[1] ?? '') && (t.length <= 2 || t.slice(2).includes('sat'))).map((t) => t[1]);
  const p2pk = normalizeP2pk(ev.tags.find((t) => t[0] === 'pubkey')?.[1] ?? '');
  if (!relays.length || !mints.length || !p2pk) return undefined;
  return { route: 'A', p: recipientHex, p2pk, mints, relays: [...new Set(relays)], label, fetchedAt: Date.now() };
}

/** Fetch the newest kind:10019 of a pubkey from public relays. */
export async function fetchNutzapInfo(recipientHex: string, relays = LOOKUP_RELAYS, timeoutMs = 6000, label?: string): Promise<RouteATarget | undefined> {
  const events: Event[] = [];
  await Promise.all(relays.map((url) => new Promise<void>((resolve) => {
    let ws: WebSocket;
    const done = () => { try { ws.close(); } catch { /* */ } resolve(); };
    const timer = setTimeout(done, timeoutMs);
    try { ws = new WebSocket(url); } catch { clearTimeout(timer); resolve(); return; }
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'ns', { kinds: [10019], authors: [recipientHex], limit: 1 }]));
    ws.onmessage = (m) => {
      try {
        const d = JSON.parse(String(m.data));
        if (d[0] === 'EVENT' && d[2]?.pubkey === recipientHex && d[2]?.kind === 10019 && verifyEvent(d[2])) events.push(d[2]);
        if (d[0] === 'EOSE') { clearTimeout(timer); done(); }
      } catch { /* ignore junk */ }
    };
    ws.onerror = () => { clearTimeout(timer); done(); };
  })));
  events.sort((a, b) => b.created_at - a.created_at);
  return events[0] ? parseNutzapInfo(events[0], recipientHex, label) : undefined;
}

/** A signed kind:9321 nutzap carrying P2PK-locked proofs (with DLEQ), signed by a fresh key. */
export function buildNutzap(proofs: WireProof[], mintAsListed: string, recipientHex: string, memo: string, now = Date.now()): Event {
  const tags: string[][] = [
    ...proofs.map((p) => ['proof', JSON.stringify({ amount: p.amount, C: p.C, id: p.id, secret: p.secret, ...(p.dleq ? { dleq: p.dleq } : {}) })]),
    ['unit', 'sat'],
    ['u', mintAsListed],
    ['p', recipientHex],
  ];
  return finalizeEvent({ kind: 9321, created_at: Math.floor(now / 1000), tags, content: memo }, generateSecretKey());
}

export type Publisher = (event: Event, relays: string[]) => Promise<{ accepted: number; errors: string[] }>;

/** Publish to every relay; the nutzap counts as delivered when at least one relay accepted it (or already had it). */
export const publishToRelays: Publisher = async (event, relays) => {
  const errors: string[] = [];
  let accepted = 0;
  await Promise.all(relays.map((url) => new Promise<void>((resolve) => {
    let ws: WebSocket;
    const done = (err?: string) => { if (err) errors.push(`${url}: ${err}`); try { ws.close(); } catch { /* */ } resolve(); };
    const timer = setTimeout(() => done('timeout'), 8000);
    try { ws = new WebSocket(url); } catch (e: any) { clearTimeout(timer); errors.push(`${url}: ${e?.message ?? e}`); resolve(); return; }
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]));
    ws.onmessage = (m) => {
      try {
        const d = JSON.parse(String(m.data));
        if (d[0] === 'OK' && d[1] === event.id) {
          clearTimeout(timer);
          if (d[2] === true || /duplicate/i.test(String(d[3] ?? ''))) { accepted++; done(); } else done(String(d[3] ?? 'rejected'));
        }
      } catch { /* ignore */ }
    };
    ws.onerror = () => { clearTimeout(timer); done('connection failed'); };
  })));
  return { accepted, errors };
};
