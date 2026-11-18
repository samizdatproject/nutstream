import { describe, it, expect } from 'vitest';
import { Meter } from '../src/core/meter.ts';
import { classify, endpointUrl, buildBody } from '../src/core/routeB.ts';

describe('meter', () => {
  it('1 sat/min: 60 s of listening is exactly 1 sat, sub-sat remainder carries', () => {
    const m = new Meter({ satsPerMinute: 1, capSats: 100 });
    for (let t = 0; t <= 59; t++) m.position(t, 1000);
    expect(m.dueSats).toBe(0); // 59 s
    m.position(60, 1000);
    expect(m.take()).toBe(1);
    for (let t = 61; t <= 150; t++) m.position(t, 1000);
    expect(m.take()).toBe(1); // 90 s more = 1.5 sat: 1 now, 0.5 carried
    for (let t = 151; t <= 180; t++) m.position(t, 1000);
    expect(m.take()).toBe(1);
  });

  it('seeks and pauses are not paid for', () => {
    const m = new Meter({ satsPerMinute: 60, capSats: 1000 }); // 1 sat per second
    m.position(0, 1000);
    m.position(1, 1000);
    m.position(600, 1000); // jumped 10 minutes ahead
    m.position(601, 1000);
    m.position(602, 1000, 1, false); // paused
    m.position(100, 1000); // seeked back
    expect(m.take()).toBe(2);
  });

  it('pays by content time at 2x speed', () => {
    const m = new Meter({ satsPerMinute: 60, capSats: 1000 });
    m.position(0, 500, 2);
    for (let t = 2; t <= 20; t += 2) m.position(t, 1000, 2);
    expect(m.take()).toBe(20);
  });

  it('stops at the cap, counting fees and what was already taken', () => {
    const m = new Meter({ satsPerMinute: 60, capSats: 10 });
    m.position(0, 1000);
    for (let t = 1; t <= 6; t++) m.position(t, 1000);
    expect(m.take()).toBe(6);
    m.chargeFee(2);
    for (let t = 7; t <= 30; t++) m.position(t, 1000);
    expect(m.take()).toBe(2);
    expect(m.exhausted).toBe(true);
    m.giveBack(2);
    expect(m.dueSats).toBe(2);
  });

  it('rejects fractional rates', () => {
    expect(() => new Meter({ satsPerMinute: 1.5, capSats: 10 })).toThrow();
  });
});

describe('route B replies (CASHU_STREAMING.md table)', () => {
  const j = (o: unknown) => JSON.stringify(o);
  it.each([
    [200, { success: true, amount_sats: 10, mint_url: 'm' }, 'paid'],
    [409, { error: 'already_redeemed' }, 'paid'],
    [400, { error: 'already_spent' }, 'paid'],
    [400, { error: 'amount_too_small' }, 'too-small'],
    [400, { error: 'untrusted_mint', accepted_mints: ['a'] }, 'wrong-mint'],
    [400, { error: 'unsupported_mint' }, 'wrong-mint'],
    [503, { error: 'disabled' }, 'pause'],
    [503, { error: 'unavailable' }, 'pause'],
    [400, { error: 'invalid_payload' }, 'bug'],
    [400, { error: 'unsupported_unit' }, 'bug'],
    [500, { error: 'boom' }, 'retry'],
    [429, { error: 'rate_limited' }, 'retry'],
    [200, { success: false }, 'retry'],
  ])('%i %j -> %s', (status, body, kind) => {
    expect(classify(status, j(body)).kind).toBe(kind);
  });
  it('non-JSON 502 is retried', () => expect(classify(502, '<html>').kind).toBe('retry'));
  it('untrusted_mint carries the accepted mints', () => {
    expect(classify(400, j({ error: 'untrusted_mint', accepted_mints: ['https://a', 3] }))).toEqual(
      { kind: 'wrong-mint', error: 'untrusted_mint', acceptedMints: ['https://a'] });
  });
  it('stream adds ?action=stream, boost does not', () => {
    const t = { url: 'https://h/api/community/ecash-payment' };
    expect(endpointUrl(t, 'stream')).toBe('https://h/api/community/ecash-payment?action=stream');
    expect(endpointUrl(t, 'boost')).toBe('https://h/api/community/ecash-payment');
  });
  it('body has numeric amounts and the request id when present', () => {
    const b = buildBody({ url: 'https://h', requestId: 'r1' }, 'https://mint', [{ id: 'k', amount: 8, secret: 's', C: 'c' }], 'hi');
    expect(JSON.parse(JSON.stringify(b))).toEqual({ id: 'r1', mint: 'https://mint', unit: 'sat', memo: 'hi', proofs: [{ id: 'k', amount: 8, secret: 's', C: 'c' }] });
  });
});
