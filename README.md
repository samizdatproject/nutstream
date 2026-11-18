# nutstream

**Pay podcasts by the minute with Cashu ecash: privately, from any Podcasting 2.0 feed.**

nutstream is the listener side of Cashu streaming payments. Paste any podcast feed, set a rate and a budget, press
play: it meters what you actually hear and pays the show in small batches over plain HTTPS. It implements
**Route B** of Nodesignal's [Cashu streaming spec](https://gitlab.com/nodesignal/podcasting_tools/-/blob/main/CASHU_STREAMING.md)
(NUT-18 payloads POSTed to `…/ecash-payment?action=stream`), the route that endpoint already runs in production but
that no podcast app used yet. It also reads (and helps shows publish) the spec's proposed
`<podcast:txt purpose="cashu">` feed record.

- **Live demo:** _(GitHub Pages link once published)_. "Demo show" mode runs on the free test mint: add test sats,
  press play, and watch payments arrive in the demo show's inbox. No real money.
- **Built for [Nut November 2026](https://nutnovember.org)**, Value4Value track. Everything in this repo was written
  from Nov 18, 2026.

## Why Route B

- **Private.** Nutzap streaming (Route A) publishes a `kind:9321` event for every payment: in the spec's own words,
  a world-readable minute-by-minute record of what you listen to. Route B sends the ecash straight to the show over
  TLS. Nothing public, no Nostr identity needed.
- **Any feed.** nutstream finds the endpoint from the feed itself:
  1. a `<podcast:txt purpose="cashu">creqA…</podcast:txt>` record (NUT-18 request with an HTTP POST transport), or
  2. for Sovereigncast shows, the `purpose="sovereigncast"` host plus `/api/community/ecash-payment`. This second
     rule is **our inference** from the documented path; the player labels it as inferred.
- **Static.** A web page and the mint, nothing else: the live endpoint answers CORS preflights with `*`, so no proxy.

## What it does

| | |
|---|---|
| Meter | Counts audible played seconds × your rate (sats/minute) in whole millisats with a carried remainder. Seeking, muting and the "Pay while I listen" switch stop it. Pays by episode time (2× speed pays 2 minutes per wall minute). |
| Budget | A cap per listening session that includes mint fees. |
| Batches | Every 5 minutes while playing (the spec's default; 30 s in the demo), and on pause, end of episode, or tab close. |
| Boosts | One-off payments with a message: the same endpoint without `?action=stream`, text in `memo`. |
| Wallet | One wallet per mint in IndexedDB. Fund with a Lightning invoice or a pasted token; take the whole balance out as one token. |
| Show owners | Generates the `purpose="cashu"` record for your endpoint: no amount, not single-use, unit `sat`, one POST transport, no mint list (apps learn accepted mints from `untrusted_mint`). |

## Money safety

A wallet that streams payments touches the mint constantly, so every failure window is handled and tested:

- **Persist before every network call.** The swap preview (which holds the input proofs) is saved before the swap;
  the proofs for the show are saved before the POST. Closing the tab at any moment loses nothing.
- **Lost replies.** A lost swap reply is replayed from the persisted preview (the mint caches `/v1/swap`, NUT-19).
  After the cache window, the outputs are recovered with **NUT-09 restore** from the same preview: verified against
  the test mint, byte-identical proofs. A lost POST reply is retried and comes back as `already_redeemed`, counted once.
- **The spec's reply table**, exactly: `already_redeemed`/`already_spent` → paid; `amount_too_small` → held and sent
  with the next batch; `untrusted_mint`/`unsupported_mint` → proofs back, accepted mints shown; `disabled`/`unavailable`
  → pause 30 min; `invalid_payload`/`unsupported_unit` → no retry; anything else → hold the proofs, back off, retry.
- **Several tabs.** All wallet work runs under a Web Lock and reloads the saved state first, so two tabs never pick
  the same proofs or overwrite each other.
- **Fees.** The sender covers the show's redeem fee (`includeFees`), so the show nets exactly what the meter says;
  every fee is booked against your budget.
- **Also:** paid invoices are minted even after the tab was closed; token receives are crash-safe; an exported
  token stays in the wallet until you confirm you saved it; stuck payments can be cancelled (proofs swapped back);
  sats owed to one show never go to another; POSTs time out after 20 s; only `https` endpoints.

An independent code review of the money path found three critical issues before the first commit (stale state
across tabs, a recovery path that wrote off recoverable funds, a wallet overwrite across mints); all are fixed and
covered by tests.

## Run it

```sh
npm install
npm run dev          # the page, with the demo show
npm test             # 57 unit tests (meter, reply table, outbox failure windows, feed discovery)
npm run test:live    # + end-to-end against the free test mint (fake Lightning) and a mock show over real HTTP
npm run mock         # the mock Route B endpoint on 127.0.0.1:8787, for testing other clients
npm run build        # static site in dist/
```

## Layout

| Path | What |
|---|---|
| `src/core/meter.ts` | Integer millisat meter, seek detection, budget cap |
| `src/core/wallet.ts` | Wallet + payment outbox (the state machine above) |
| `src/core/ledger.ts` | cashu-ts 4 wrapper: crash-safe send/receive, NUT-07 states, NUT-09 restore, invoices |
| `src/core/routeB.ts` | Route B payload, `?action=stream`, the reply table |
| `src/core/discover.ts` | Feed parsing, endpoint discovery, `purpose="cashu"` record encode/decode |
| `src/core/session.ts` | Wires an `<audio>` element to the meter and the wallet |
| `src/mock/` | A Route B endpoint built only from the spec, redeeming at the mint for real (tests + demo show) |
| `src/ui/` | The page |

## Limits (honest list)

- **Route A (nutzaps) is not implemented.** Feeds with only a Nostr npub are shown as "no Cashu endpoint".
- **Accepted mints.** Without a mint list in the record, a show's mints are learned from its `untrusted_mint` reply;
  you may need to fund a second wallet at one of them.
- **Keysend-only shows** (most `podcast:value` recipients) cannot be paid from a mint; nutstream does not try.
- **The meter's budget is per listening session**; it resets on reload (sats already metered are kept and sent).
- **Browser storage** can be cleared by the user or the browser; the page asks for persistent storage and you can
  export your balance at any time. Keep small amounts.
- **Not yet paid with real sats end to end** against a live show from this repo: the demo uses the test mint.

## How this was built

Written by samizdatproject with Claude Code (Anthropic), which wrote most of the code and tests under review;
an independent AI code review checked the money path. Nut November rules encourage coding agents.

## License

MIT. Demo music: Komiku, CC0 (see [CREDITS.md](CREDITS.md)).
