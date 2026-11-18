// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFeed, makeCashuRecord, fromCashuRecord, parseDuration } from '../src/core/discover.ts';

const nodesignal = readFileSync(join(process.cwd(), 'test/fixtures/nodesignal-trimmed.xml'), 'utf8');

describe('feed discovery', () => {
  it('real Nodesignal feed: infers the Sovereigncast Route B endpoint, finds the npub and episodes', () => {
    const f = parseFeed(nodesignal);
    expect(f.title).toMatch(/Nodesignal/i);
    expect(f.routeB).toMatchObject({ url: 'https://pm.nodesignal.space/api/community/ecash-payment', source: 'sovereigncast-inferred' });
    expect(f.npub).toMatch(/^npub1/);
    expect(f.episodes).toHaveLength(2);
    expect(f.episodes[0].audioUrl).toMatch(/^https:/);
    expect(f.suggestedSatsPerMinute).toBeUndefined(); // channel "suggested" is 21,000 sats: a boost, not a rate
  });

  it('a purpose="cashu" record wins over the inferred endpoint', () => {
    const { xml, creq } = makeCashuRecord('https://show.example/api/community/ecash-payment', 'Example show');
    expect(creq).toMatch(/^creqA/);
    const feed = nodesignal.replace('<podcast:txt purpose="sovereigncast">', `${xml}\n<podcast:txt purpose="sovereigncast">`);
    const f = parseFeed(feed);
    expect(f.routeB).toMatchObject({ url: 'https://show.example/api/community/ecash-payment', source: 'cashu-record' });
  });

  it('round-trips the record and rejects non-https or non-sat requests', () => {
    const { creq } = makeCashuRecord('https://a.example/pay');
    expect(fromCashuRecord(creq)).toMatchObject({ url: 'https://a.example/pay' });
    expect(() => makeCashuRecord('http://a.example/pay')).toThrow();
    expect(fromCashuRecord('creqAgarbage')).toBeUndefined();
  });

  it('reads a sane suggested streaming rate (BTC per minute)', () => {
    const feed = nodesignal.replace('suggested="0.00021000000"', 'suggested="0.00000005000"');
    expect(parseFeed(feed).suggestedSatsPerMinute).toBe(5);
  });

  it('rejects non-feeds', () => {
    expect(() => parseFeed('<html><body>hi</body></html>')).toThrow();
    expect(() => parseFeed('not xml <')).toThrow();
  });

  it('parses itunes durations', () => {
    expect(parseDuration('1:02:03')).toBe(3723);
    expect(parseDuration('95')).toBe(95);
    expect(parseDuration('')).toBeUndefined();
  });
});
