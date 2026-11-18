// The nutstream page: one player, one wallet per mint, a demo show running in the page.
import { CashuLedger } from '../core/ledger.ts';
import { NutWallet } from '../core/wallet.ts';
import { IdbStore, walletStoreKey, requestPersistentStorage } from '../core/store.ts';
import { StreamSession, type SessionView } from '../core/session.ts';
import { parseFeed, makeCashuRecord, type FeedInfo } from '../core/discover.ts';
import { MockReceiver } from '../mock/receiver.ts';
import { cashuRedeem } from '../mock/cashuRedeem.ts';
import type { FetchLike } from '../core/routeB.ts';
import type { Batch, RouteBTarget, WalletState } from '../core/types.ts';

const TEST_MINT = 'https://testnut.cashu.space';
const DEMO_HOST = 'demo-show.invalid';
const DEMO_FEED = new URL('demo/feed.xml', location.href).toString();
const SAMPLE_FEED = 'https://serve.podhome.fm/rss/e8df0b13-47de-544a-99b7-ec7cbd960a16'; // Nodesignal (CORS *)

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const audio = $<HTMLAudioElement>('audio');

// --- the demo show: an in-page Route B endpoint on the test mint ---
const demoShow = new MockReceiver({ acceptedMints: [TEST_MINT], redeem: cashuRedeem() });
const demoFetch = demoShow.asFetch('demo');
const routedFetch: FetchLike = (url, init) =>
  new URL(url).host === DEMO_HOST ? demoFetch(url, init) : (fetch(url, init) as unknown as ReturnType<FetchLike>);

type Mode = 'demo' | 'live';
let mode: Mode = 'demo';
let wallet: NutWallet | undefined;
let feed: FeedInfo | undefined;
let session: StreamSession | undefined;
let invoicePoll: number | undefined;

// ---------- mode ----------

function setMode(m: Mode) {
  mode = m;
  $('mode-demo').setAttribute('aria-selected', String(m === 'demo'));
  $('mode-live').setAttribute('aria-selected', String(m === 'live'));
  $('feed-picker').hidden = m === 'demo';
  $('live-mint').hidden = m === 'demo';
  $('inbox-card').hidden = m === 'demo' ? false : true;
  $<HTMLInputElement>('rate').value = m === 'demo' ? '10' : '5';
  $<HTMLInputElement>('cap').value = m === 'demo' ? '100' : '300';
  stopSession();
  if (m === 'demo') {
    void openWallet(TEST_MINT).then(() => loadFeedUrl(DEMO_FEED));
  } else {
    const savedMint = safeGet('nutstream:mint');
    $<HTMLInputElement>('mint').value = savedMint ?? '';
    $<HTMLInputElement>('feed-url').value = safeGet('nutstream:feed') ?? SAMPLE_FEED;
    if (savedMint) void openWallet(savedMint);
    else { wallet = undefined; renderWallet(); msg('Choose a mint the show accepts. Not sure? Load the feed and send a small boost: the show answers with the mints it accepts.'); }
  }
}

// ---------- wallet ----------

async function openWallet(mintUrl: string) {
  const url = mintUrl.trim().replace(/\/+$/, '');
  if (mode === 'demo' && url !== TEST_MINT) throw new Error('demo mode uses only the test mint');
  if (mode === 'live' && url === TEST_MINT) { msg('That is the test mint: use Demo mode for test sats.'); return; }
  try {
    wallet = await new NutWallet({ store: new IdbStore(walletStoreKey(url)), ledger: new CashuLedger(url), fetch: routedFetch }).open();
  } catch (e: any) {
    msg(`Could not open the wallet: ${e?.message ?? e}`);
    return;
  }
  wallet.onChange(renderWallet);
  renderWallet(wallet.snapshot());
  // finish whatever the last visit left: interrupted receives, paid invoices, queued payments
  void wallet.resumeReceives().catch(() => undefined);
  void wallet.reconcile();
  void wallet.pump().catch(() => undefined);
  if (wallet.snapshot().quotes.length) pollInvoices();
  if (mode === 'live') safeSet('nutstream:mint', url);
}

function renderWallet(s?: WalletState) {
  $('mint-label').textContent = wallet ? new URL(wallet.mintUrl).host : 'no mint chosen';
  $('balance').textContent = wallet ? String(wallet.balance) : '0';
  const fly = wallet?.inFlight ?? 0;
  const owed = s?.owed ?? 0;
  $('inflight').textContent = fly || owed ? ` · ${fly} sending${owed ? `, ${owed} owed` : ''}` : '';
  renderHistory(s?.batches ?? []);
  const exp = s?.pendingExport;
  const ta = $<HTMLTextAreaElement>('token-out');
  ta.hidden = !exp;
  $('export-done').hidden = !exp;
  if (exp && ta.value !== exp.token) ta.value = exp.token;
}

function renderHistory(batches: Batch[]) {
  const ol = $('history');
  ol.replaceChildren();
  const list = [...batches].reverse().slice(0, 30);
  if (!list.length) { ol.append(li('Nothing sent yet.', 'muted')); return; }
  for (const b of list) {
    const when = new Date(b.doneAt ?? b.createdAt).toLocaleTimeString();
    const status = {
      new: 'queued', prepared: 'sending', ready: 'sending', done: 'paid', returned: 'held back (too small)',
      blocked: 'show refused this mint', failed: 'failed',
    }[b.status];
    const item = li('', `st-${b.status}`);
    item.append(span(`${when} · ${b.kind === 'boost' ? 'Boost' : 'Stream'} ${b.amount} sats`), span(status, 'pill'));
    if (b.fee) item.append(span(`fee ${b.fee}`, 'muted small'));
    if (b.memo) item.append(span(`“${b.memo}”`, 'small'));
    if (b.lastError && b.status !== 'done') item.append(span(b.lastError === 'insufficient-funds' ? 'waiting: add sats to the wallet' : b.lastError, 'small muted'));
    if (b.acceptedMints?.length) item.append(span(`The show accepts: ${b.acceptedMints.join(', ')}`, 'small'));
    if ((b.status === 'ready' && b.attempts >= 2) || (b.status === 'new' && b.lastError === 'insufficient-funds')) {
      const c = document.createElement('button');
      c.className = 'link';
      c.textContent = 'Cancel';
      c.onclick = () => void wallet?.cancel(b.id).then((ok) => msg(ok ? 'Cancelling: the sats come back to the wallet (or the payment counts as paid if the show already took it).' : 'Could not cancel right now; try again later.')).catch((e) => msg(`Could not cancel: ${e?.message ?? e}`));
      item.append(c);
    }
    ol.append(item);
  }
}

// ---------- feeds ----------

async function loadFeedUrl(url: string) {
  setShow('Loading…', '');
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    useFeed(await res.text(), url);
    if (mode === 'live') safeSet('nutstream:feed', url);
  } catch (e: any) {
    setShow('Could not load the feed', `${e?.message ?? e}. If the host blocks browsers, paste the feed XML below.`);
    if (mode === 'live') ($('paste-box') as HTMLDetailsElement).open = true;
  }
}

function useFeed(xml: string, from?: string) {
  try {
    feed = parseFeed(xml);
  } catch (e: any) {
    setShow('Not a podcast feed', String(e?.message ?? e));
    return;
  }
  if (mode === 'demo') {
    // the demo feed names its public URLs; play the copies served with this page
    for (const ep of feed.episodes) ep.audioUrl = new URL(`demo/${ep.audioUrl.split('/').pop()}`, location.href).toString();
  }
  const img = $<HTMLImageElement>('show-image');
  img.hidden = !feed.image;
  if (feed.image) img.src = feed.image;
  const r = feed.routeB;
  setShow(feed.title,
    r ? `Pays ${new URL(r.url).host} over Route B (NUT-18 HTTP)${r.source === 'sovereigncast-inferred' ? ' · endpoint inferred from the feed\'s Sovereigncast host' : ' · from the feed\'s cashu record'}`
      : `No Cashu endpoint in this feed${feed.npub ? ' (it has a Nostr npub: nutzaps are not supported yet)' : ''}. You can still listen.`);
  if (feed.suggestedSatsPerMinute && mode === 'live') $<HTMLInputElement>('rate').value = String(feed.suggestedSatsPerMinute);
  const sel = $<HTMLSelectElement>('episode');
  sel.replaceChildren(...feed.episodes.map((ep, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = ep.title;
    return o;
  }));
  if (!feed.episodes.length) sel.append(new Option('No audio episodes in this feed'));
  selectEpisode(0);
  void from;
}

function setShow(title: string, route: string) { $('show-title').textContent = title; $('route').textContent = route; }

function selectEpisode(i: number) {
  stopSession();
  const ep = feed?.episodes[i];
  if (!ep) { audio.removeAttribute('src'); return; }
  audio.src = ep.audioUrl;
  startSession();
}

// ---------- session ----------

function target(): RouteBTarget | undefined { return feed?.routeB ? { url: feed.routeB.url, requestId: feed.routeB.requestId, label: feed.title } : undefined; }

const spentKey = (t: RouteBTarget) => `nutstream:spent:${JSON.stringify([t.url, feed?.episodes[Number($<HTMLSelectElement>('episode').value) || 0]?.guid ?? ''])}`;

function startSession() {
  const t = target();
  if (!wallet || !t) { renderMeter(); return; }
  const key = spentKey(t);
  session = new StreamSession({
    alreadySpent: Math.max(0, Math.floor(Number(safeGet(key) ?? 0)) || 0),
    feeReserveSats: mode === 'demo' ? 2 : 1,
    onSpent: (n) => safeSet(key, String(n)),
    wallet, audio, target: t,
    satsPerMinute: num('rate', 0, 100), capSats: num('cap', 0, 1_000_000),
    sendEveryMs: mode === 'demo' ? 30_000 : 5 * 60_000,
    minBatchSats: mode === 'demo' ? 3 : 5,
    onUpdate: renderMeter,
    onError: (m) => msg(m),
  });
  session.setPaused(!$<HTMLInputElement>('paying').checked);
  session.start();
}

function stopSession() { session?.stop(); session = undefined; renderMeter(); }

function renderMeter(v?: SessionView) {
  const cap = v?.capSats ?? num('cap', 0, 1_000_000);
  const spent = v?.spent ?? 0;
  $('spent').textContent = String(spent);
  $('cap-show').textContent = String(cap);
  $('accrued').textContent = ((v?.pendingMsat ?? 0) / 1000).toFixed(3);
  ($('bar-fill') as HTMLElement).style.width = `${cap ? Math.min(100, (spent / cap) * 100) : 0}%`;
  let next = '';
  if (!wallet) next = 'choose a mint to pay';
  else if (!target()) next = 'this show has no Cashu endpoint';
  else if (v?.paused) next = 'payments paused';
  else if (v?.exhausted) next = 'budget used up';
  else if (v?.nextSendInMs !== undefined) next = `next payment in ${fmt(v.nextSendInMs)}`;
  else next = 'press play';
  $('next').textContent = next;
}

// ---------- wiring ----------

$('mode-demo').onclick = () => setMode('demo');
$('mode-live').onclick = () => setMode('live');
$('feed-load').onclick = () => void loadFeedUrl($<HTMLInputElement>('feed-url').value.trim());
$('feed-parse').onclick = () => useFeed($<HTMLTextAreaElement>('feed-xml').value);
$<HTMLSelectElement>('episode').onchange = (e) => selectEpisode(Number((e.target as HTMLSelectElement).value));
$('rate').onchange = () => session?.setRate(num('rate', 0, 100));
$('cap').onchange = () => { session?.setCap(num('cap', 0, 1_000_000)); renderMeter(session?.view()); };
$<HTMLInputElement>('paying').onchange = (e) => session?.setPaused(!(e.target as HTMLInputElement).checked);
$('mint-use').onclick = () => { stopSession(); void openWallet($<HTMLInputElement>('mint').value).then(() => feed && selectEpisode(Number($<HTMLSelectElement>('episode').value) || 0)); };

$('boost').onsubmit = async (e) => {
  e.preventDefault();
  const t = target();
  if (!wallet || !t) return msg(!wallet ? 'Choose a mint first.' : 'This show has no Cashu endpoint.');
  try {
    await wallet.queueBoost(t, num('boost-amount', 1, 1_000_000), $<HTMLInputElement>('boost-memo').value);
    $<HTMLInputElement>('boost-memo').value = '';
    await wallet.pump();
  } catch (err: any) { msg(err?.message ?? String(err)); }
};

$('fund').onsubmit = async (e) => {
  e.preventDefault();
  if (!wallet) return msg('Choose a mint first.');
  const amount = num('fund-amount', 1, 100_000);
  if (!(await requestPersistentStorage())) msg('Note: this browser may clear site data. Keep only small amounts here, and use "Take the balance out" before clearing.');
  try {
    const inv = await wallet.createInvoice(amount);
    $('invoice').hidden = false;
    $<HTMLTextAreaElement>('invoice-text').value = inv.request;
    $<HTMLAnchorElement>('invoice-open').href = `lightning:${inv.request}`;
    $('invoice-status').textContent = mode === 'demo' ? 'Test mint: this invoice pays itself…' : 'Waiting for payment… (you can close the page: it is minted on your next visit)';
    pollInvoices();
  } catch (err: any) { msg(`The mint did not give an invoice: ${err?.message ?? err}`); }
};

function pollInvoices() {
  clearInterval(invoicePoll);
  const w = wallet;
  if (!w) return;
  invoicePoll = window.setInterval(async () => {
    if (w !== wallet) return clearInterval(invoicePoll);
    try {
      const got = await w.claimInvoices();
      if (got) { $('invoice').hidden = true; msg(`Added ${got} sats.`); }
      const quotes = w.snapshot().quotes;
      // stop polling once nothing is left, or the remaining invoices are over an hour old (they are checked on each visit)
      if (!quotes.length || quotes.every((q) => Date.now() - q.at > 3600_000)) { clearInterval(invoicePoll); $('invoice').hidden = true; }
    } catch { /* offline: keep polling */ }
  }, 2000);
}
$('invoice-copy').onclick = () => void navigator.clipboard?.writeText($<HTMLTextAreaElement>('invoice-text').value);

$('token-receive').onclick = async () => {
  if (!wallet) return msg('Choose a mint first.');
  if (!(await requestPersistentStorage())) msg('Note: this browser may clear site data; keep small amounts here.');
  try { msg(`Received ${await wallet.receiveToken($<HTMLTextAreaElement>('token-in').value)} sats.`); $<HTMLTextAreaElement>('token-in').value = ''; }
  catch (err: any) { msg(`Could not receive: ${err?.message ?? err}`); }
};

$('export').onclick = async () => {
  if (!wallet) return;
  const out = await wallet.exportAll();
  if (!out) { msg('The wallet is empty.'); return; }
  $<HTMLTextAreaElement>('token-out').select();
  msg(`Exported ${out.amount} sats. Copy the token into another Cashu wallet, then press "I saved it".`);
};
$('export-done').onclick = () => void wallet?.clearExport().then(() => msg('Done.'));

$('owner-make').onclick = () => {
  const ta = $<HTMLTextAreaElement>('owner-out');
  try { ta.value = makeCashuRecord($<HTMLInputElement>('owner-url').value.trim()).xml; ta.hidden = false; ta.select(); }
  catch (err: any) { ta.hidden = false; ta.value = `Error: ${err?.message ?? err}`; }
};

// another tab may have changed the wallet: re-read it when this one comes back
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void wallet?.refresh().catch(() => undefined); });

demoShow.onReceive((r) => {
  $('inbox-total').textContent = String(demoShow.total);
  $('inbox').prepend(li(`${new Date(r.at).toLocaleTimeString()} · ${r.kind === 'boost' ? 'Boost' : 'Stream'} ${r.amount} sats${r.memo ? ` · “${r.memo}”` : ''}`));
});

// ---------- helpers ----------

function num(id: string, min: number, max: number) {
  const v = Math.floor(Number($<HTMLInputElement>(id).value));
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min;
}
function fmt(ms: number) { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function li(text: string, cls = '') { const e = document.createElement('li'); e.textContent = text; if (cls) e.className = cls; return e; }
function span(text: string, cls = '') { const e = document.createElement('span'); e.textContent = text; if (cls) e.className = cls; return e; }
function msg(t: string) { $('wallet-msg').textContent = t; }
function safeGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

setMode('demo');
