// Turns listening into sats. Pure and integer-only: no floating-point money.
//
// - Counts *content* seconds actually played (at 2x speed you pay for 2 minutes of episode per wall minute,
//   the same as Podcasting 2.0 apps that meter by episode time). Seeks and jumps are not paid for.
// - Accrues millisats and carries the remainder, so 1 sat/min never rounds away.
// - Stops at the budget cap. The cap covers what was paid, what is still queued and the mint fees.

export interface MeterOptions {
  satsPerMinute: number; // integer >= 0
  capSats: number; // budget for this session (episode)
  /** Budget already used for this episode on an earlier visit (so a reload does not grant a fresh budget). */
  alreadySpent?: number;
  /** Sats kept free for the fee of the batch still to come, so the cap is not overshot by it. */
  feeReserve?: number;
}

export class Meter {
  private lastPos?: number; // seconds, last accepted playhead position
  private remainder = 0; // (content ms × sats/min) not yet turned into msat, in units of 1/60 msat
  private msat = 0; // accrued, not yet taken
  private takenSats = 0; // already handed to the outbox
  private feesSats = 0; // mint fees charged against this budget
  private rate: number;
  private cap: number;

  private reserve: number;

  constructor(opts: MeterOptions) {
    this.rate = check(opts.satsPerMinute, 'satsPerMinute');
    this.cap = check(opts.capSats, 'capSats');
    this.takenSats = check(opts.alreadySpent ?? 0, 'alreadySpent');
    this.reserve = check(opts.feeReserve ?? 0, 'feeReserve');
  }

  get feeReserve() { return this.reserve; }
  set feeReserve(n: number) { this.reserve = check(n, 'feeReserve'); }

  get satsPerMinute() { return this.rate; }
  set satsPerMinute(n: number) { this.rate = check(n, 'satsPerMinute'); }
  get capSats() { return this.cap; }
  set capSats(n: number) { this.cap = check(n, 'capSats'); }

  /**
   * Feed the playhead from the player (e.g. on every `timeupdate`).
   * `wallMs` is the wall time since the previous call; jumps larger than the playback could cover are seeks.
   */
  position(seconds: number, wallMs: number, playbackRate = 1, playing = true) {
    const prev = this.lastPos;
    this.lastPos = seconds;
    if (!playing || prev === undefined) return;
    const delta = seconds - prev;
    if (delta <= 0) return; // paused, rewound or seeked back
    const maxDelta = Math.max(1.5, (wallMs / 1000) * Math.max(playbackRate, 1) * 1.5 + 0.5);
    if (delta > maxDelta) return; // a seek forward, not listening
    this.addContentMs(Math.round(delta * 1000));
  }

  /** Forget the playhead (call on `seeking`, `emptied`, episode change). */
  reset() { this.lastPos = undefined; }

  addContentMs(ms: number) {
    if (this.exhausted) return;
    // msat = ms × (sats/min) × 1000 msat/sat ÷ 60000 ms/min = ms × rate ÷ 60
    const units = ms * this.satsPerMinute + this.remainder;
    this.msat += Math.floor(units / 60);
    this.remainder = units % 60;
    const room = (this.capSats - this.takenSats - this.feesSats - this.activeReserve) * 1000;
    if (this.msat > room) this.msat = Math.max(0, room);
  }

  get accruedMsat() { return this.msat; }

  /** Whole sats ready to send; the sub-sat remainder stays in the meter. */
  get dueSats() { return Math.floor(this.msat / 1000); }

  /** Hand the due sats to the outbox. */
  take(): number {
    const n = this.dueSats;
    this.msat -= n * 1000;
    this.takenSats += n;
    return n;
  }

  /** Give sats back (e.g. the show answered amount_too_small) so they are sent with the next batch. */
  giveBack(n: number) {
    this.takenSats -= n;
    this.msat += n * 1000;
  }

  chargeFee(n: number) { this.feesSats += n; }

  /** Sats that were taken but never paid (payment refused or cancelled): free that part of the budget. */
  refund(n: number) { this.takenSats = Math.max(0, this.takenSats - n); }

  get spentSats() { return this.takenSats + this.feesSats; }
  /** The reserve never takes the whole budget: a tiny cap still meters something. */
  private get activeReserve() { return Math.min(this.reserve, Math.max(0, this.capSats - 1)); }
  get exhausted() { return this.capSats > 0 ? (this.spentSats + this.activeReserve) * 1000 + this.msat >= this.capSats * 1000 : true; }
}

function check(n: number, name: string) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number >= 0`);
  return n;
}
