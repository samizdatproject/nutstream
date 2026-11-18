// Read a Podcasting 2.0 feed and find where Cashu payments go.
//   1. <podcast:txt purpose="cashu">creqA…|CREQB1…</podcast:txt>  NUT-18 request with an HTTP POST transport
//      (the record proposed in Nodesignal's CASHU_STREAMING.md; nobody publishes it yet, nutstream reads and writes it)
//   2. <podcast:txt purpose="sovereigncast">https://host</podcast:txt>  a Sovereigncast instance: we *infer* the
//      Route B endpoint as host + /api/community/ecash-payment (the documented path; the record itself is not in the spec)
//   3. <podcast:txt purpose="nostr">npub…</podcast:txt>  Route A (nutzaps) — shown, not paid by this version
import { decodePaymentRequest, PaymentRequest, PaymentRequestTransportType } from '@cashu/cashu-ts';
import type { RouteBTarget } from './types.ts';

export const SOVEREIGNCAST_PATH = '/api/community/ecash-payment';

export interface Episode {
  title: string;
  guid: string;
  audioUrl: string;
  type: string;
  durationSec?: number;
  published?: string;
  image?: string;
}

export interface FeedInfo {
  title: string;
  image?: string;
  link?: string;
  /** Where Route B payments go, and how we learned it. */
  routeB?: RouteBTarget & { source: 'cashu-record' | 'sovereigncast-inferred'; mints?: string[] };
  npub?: string;
  /** From <podcast:value suggested> (BTC per minute), when it is a sane streaming rate. */
  suggestedSatsPerMinute?: number;
  episodes: Episode[];
}

const NS = 'https://podcastindex.org/namespace/1.0';

export function parseFeed(xml: string, maxEpisodes = 100): FeedInfo {
  const doc = new DOMParser().parseFromString(xml.replace(/^\uFEFF/, ''), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('this is not valid feed XML');
  const channel = doc.getElementsByTagName('channel')[0];
  if (!channel) throw new Error('no <channel> in this feed');

  // Match by namespace where the parser keeps it, and by prefix otherwise (some DOM implementations flatten XML).
  const tag = (c: Element) => c.tagName.toLowerCase();
  const kids = (el: Element, name: string) =>
    Array.from(el.children).filter((c) => tag(c) === name.toLowerCase() && (!c.namespaceURI || /xhtml/.test(c.namespaceURI)));
  const text = (el: Element | undefined | null) => el?.textContent?.trim() ?? '';
  const first = (el: Element, name: string) => kids(el, name)[0];
  const podcast = (el: Element, name: string) =>
    Array.from(el.children).filter((c) => (c.namespaceURI === NS && c.localName === name) || tag(c) === `podcast:${name.toLowerCase()}`);
  const itunes = (el: Element, name: string) =>
    Array.from(el.children).find((c) => (/itunes/.test(c.namespaceURI ?? '') && c.localName === name) || tag(c) === `itunes:${name.toLowerCase()}`);

  const info: FeedInfo = {
    title: text(first(channel, 'title')) || 'Untitled show',
    link: text(first(channel, 'link')) || undefined,
    image: text(first(first(channel, 'image') ?? channel, 'url')) || itunes(channel, 'image')?.getAttribute('href') || undefined,
    episodes: [],
  };

  // Payment records on the channel
  for (const t of podcast(channel, 'txt')) {
    const purpose = t.getAttribute('purpose');
    const value = text(t);
    if (purpose === 'cashu' && !info.routeB) info.routeB = fromCashuRecord(value);
    if (purpose === 'nostr' && /^npub1[02-9ac-hj-np-z]+$/.test(value)) info.npub = value;
  }
  if (!info.routeB) {
    const sc = podcast(channel, 'txt').find((t) => t.getAttribute('purpose') === 'sovereigncast');
    if (sc) {
      try {
        const u = new URL(text(sc));
        if (u.protocol === 'https:') info.routeB = { url: `${u.origin}${SOVEREIGNCAST_PATH}`, source: 'sovereigncast-inferred', label: info.title };
      } catch { /* not a URL */ }
    }
  }
  if (info.routeB) info.routeB.label = info.title;

  // Suggested streaming rate: podcast:value suggested is in BTC per minute
  const value = podcast(channel, 'value')[0];
  const suggested = Number(value?.getAttribute('suggested'));
  if (Number.isFinite(suggested) && suggested > 0) {
    const sats = Math.round(suggested * 1e8);
    if (sats >= 1 && sats <= 100) info.suggestedSatsPerMinute = sats; // larger values are boost amounts, not rates
  }

  for (const item of kids(channel, 'item')) {
    const enc = first(item, 'enclosure');
    const url = enc?.getAttribute('url');
    if (!url || !/^https?:/.test(url)) continue;
    const type = enc!.getAttribute('type') ?? '';
    if (type && !/^audio\//.test(type)) continue;
    info.episodes.push({
      title: text(first(item, 'title')) || 'Untitled episode',
      guid: text(first(item, 'guid')) || url,
      audioUrl: url,
      type,
      durationSec: parseDuration(text(itunes(item, 'duration'))),
      published: text(first(item, 'pubDate')) || undefined,
      image: itunes(item, 'image')?.getAttribute('href') || undefined,
    });
    if (info.episodes.length >= maxEpisodes) break;
  }
  return info;
}

/** Decode a `purpose="cashu"` record (creqA… or CREQB1…) into a Route B target. */
export function fromCashuRecord(record: string): FeedInfo['routeB'] {
  try {
    const pr = decodePaymentRequest(record.trim());
    const post = pr.getTransport(PaymentRequestTransportType.POST);
    if (!post?.target) return undefined;
    const u = new URL(post.target);
    if (u.protocol !== 'https:') return undefined;
    if (pr.unit && pr.unit !== 'sat') return undefined;
    return { url: u.toString(), requestId: pr.id || undefined, source: 'cashu-record', mints: pr.mints?.length ? pr.mints : undefined };
  } catch {
    return undefined;
  }
}

/**
 * For show owners: the `purpose="cashu"` record for a Route B endpoint, as the spec proposes it:
 * no amount (the app decides), not single-use (one record serves every listener), unit sat, one POST transport,
 * no mint list (apps learn accepted mints from the untrusted_mint reply).
 */
export function makeCashuRecord(endpoint: string, description?: string) {
  const u = new URL(endpoint);
  if (u.protocol !== 'https:') throw new Error('the endpoint must be https');
  const pr = new PaymentRequest([{ type: PaymentRequestTransportType.POST, target: u.toString() }], undefined, undefined, 'sat',
    undefined, description, false);
  const creq = pr.toEncodedCreqA();
  return { creq, xml: `<podcast:txt purpose="cashu">${creq}</podcast:txt>` };
}

export function parseDuration(s: string): number | undefined {
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return undefined;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
