// Connects an <audio> element, a Meter and the wallet: meters what is heard, hands whole sats to the wallet,
// queues a streaming payment every few minutes (and on pause, end or tab hide), and keeps the outbox moving.
import { Meter } from './meter.ts';
import type { NutWallet } from './wallet.ts';
import type { Target } from './types.ts';

export interface SessionOptions {
  wallet: NutWallet;
  audio: HTMLAudioElement;
  target: Target;
  satsPerMinute: number;
  capSats: number;
  /** How often to send while playing. The spec asks for "every few minutes"; 5 by default. */
  sendEveryMs?: number;
  /** Do not send less than this on a timer or pause (each batch costs a mint fee); the rest waits. Default 5. */
  minBatchSats?: number;
  /** Budget this episode already used on an earlier visit. */
  alreadySpent?: number;
  /** Fee to keep free for the next batch until a real fee has been seen (e.g. 2 on a mint that charges fees). */
  feeReserveSats?: number;
  /** Called whenever the used budget changes, to remember it across reloads. */
  onSpent?: (spent: number) => void;
  onUpdate?: (s: SessionView) => void;
  onError?: (message: string) => void;
}

export interface SessionView {
  satsPerMinute: number;
  capSats: number;
  spent: number; // sats queued or sent in this session, plus fees
  pendingMsat: number; // accrued, not yet whole sats handed over
  nextSendInMs?: number;
  exhausted: boolean;
  paused: boolean;
}

export class StreamSession {
  readonly meter: Meter;
  private lastWall = 0;
  private lastSend = 0;
  private timers: number[] = [];
  private off: (() => void)[] = [];
  private paused = false;
  private sessionBatches = new Set<string>();
  private chargedFees = new Set<string>();
  private flushing = Promise.resolve();
  private capFlushed = false;

  constructor(private o: SessionOptions) {
    this.meter = new Meter({ satsPerMinute: o.satsPerMinute, capSats: o.capSats, alreadySpent: o.alreadySpent, feeReserve: o.feeReserveSats });
  }

  start() {
    const a = this.o.audio;
    const on = (ev: string, fn: () => void, target: EventTarget = a) => {
      target.addEventListener(ev, fn);
      this.off.push(() => target.removeEventListener(ev, fn));
    };
    on('timeupdate', () => this.tick());
    on('seeking', () => this.meter.reset());
    on('play', () => { this.lastWall = performance.now(); this.meter.reset(); this.tick(); });
    on('pause', () => this.flush('pause'));
    on('ended', () => this.flush('end'));
    on('visibilitychange', () => { if (document.visibilityState === 'hidden') this.flush('hide'); }, document);
    on('pagehide', () => this.flush('hide'), window);
    this.lastSend = performance.now();
    this.timers.push(window.setInterval(() => {
      if (!a.paused && performance.now() - this.lastSend >= this.every) this.flush('timer');
      this.emit();
    }, 1000));
    this.timers.push(window.setInterval(() => { void this.o.wallet.pump().then(() => this.chargeFees()); }, 15_000));
    this.emit();
  }

  stop() {
    this.flush('end');
    for (const t of this.timers) clearInterval(t);
    for (const f of this.off) f();
    this.timers = [];
    this.off = [];
  }

  /** The big pause button: stop metering (playback can go on, unpaid). */
  setPaused(p: boolean) {
    this.paused = p;
    this.meter.reset();
    if (p) this.flush('pause');
    this.emit();
  }

  setRate(satsPerMinute: number) { this.meter.satsPerMinute = satsPerMinute; this.emit(); }
  setCap(capSats: number) { this.meter.capSats = capSats; this.capFlushed = false; this.emit(); }

  private get every() { return this.o.sendEveryMs ?? 5 * 60_000; }

  private tick() {
    const a = this.o.audio;
    const now = performance.now();
    const wall = now - (this.lastWall || now);
    this.lastWall = now;
    this.meter.position(a.currentTime, wall, a.playbackRate, !a.paused && !this.paused && !a.muted && a.volume > 0);
    if (!this.meter.exhausted) this.capFlushed = false; // budget raised or freed: flush at the cap again
    else if (!this.capFlushed) { this.capFlushed = true; this.flush('cap'); }
  }

  /** Hand whole sats to the wallet; unless the tab is going away, queue and send them now. */
  flush(why: 'timer' | 'pause' | 'end' | 'hide' | 'cap') {
    const n = this.meter.take();
    this.flushing = this.flushing.then(async () => {
      if (n > 0) {
        try {
          await this.o.wallet.addOwed(n, this.o.target);
        } catch (e: any) {
          this.meter.giveBack(n); // not recorded anywhere: keep them in the meter for the next try
          this.o.onError?.(`could not record ${n} sats: ${e?.message ?? e}`);
          return;
        }
      }
      if (why === 'hide') return; // persisted; sent on the next visit (no network work while the page unloads)
      this.lastSend = performance.now();
      const owed = this.o.wallet.snapshot().owed;
      const small = owed < (this.o.minBatchSats ?? 5);
      if (small && (why === 'timer' || why === 'pause')) return; // too small to be worth a fee: wait for more
      for (const b of await this.o.wallet.queueOwed()) this.sessionBatches.add(b.id);
      await this.o.wallet.pump();
      this.chargeFees();
    }).catch((e: any) => this.o.onError?.(String(e?.message ?? e))).then(() => this.emit());
  }

  /** Charge the mint fees of this session's settled payments against its budget. */
  private chargeFees() {
    for (const b of this.o.wallet.snapshot().batches) {
      if (!this.sessionBatches.has(b.id) || this.chargedFees.has(b.id)) continue;
      if (b.status === 'done' || b.status === 'returned' || b.status === 'blocked' || b.status === 'failed') {
        this.meter.chargeFee(b.fee);
        if (b.status === 'blocked' || b.status === 'failed') this.meter.refund(b.amount); // never paid
        this.meter.feeReserve = b.fee; // the real fee replaces the first guess: the next batch will likely cost the same
        this.chargedFees.add(b.id);
      }
    }
  }

  view(): SessionView {
    const a = this.o.audio;
    return {
      satsPerMinute: this.meter.satsPerMinute,
      capSats: this.meter.capSats,
      spent: this.meter.spentSats,
      pendingMsat: this.meter.accruedMsat,
      nextSendInMs: a.paused ? undefined : Math.max(0, this.every - (performance.now() - this.lastSend)),
      exhausted: this.meter.exhausted,
      paused: this.paused,
    };
  }

  private lastSpent = -1;
  private emit() {
    const v = this.view();
    if (v.spent !== this.lastSpent) { this.lastSpent = v.spent; this.o.onSpent?.(v.spent); }
    this.o.onUpdate?.(v);
  }
}
