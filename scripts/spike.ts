// Spike against the free test mint (fake Lightning): mint -> crash-safe send -> receiver swap -> replay.
// Run: node --experimental-strip-types scripts/spike.ts
import { Wallet, MintQuoteState, serializeSwapPreview, deserializeSwapPreview } from '@cashu/cashu-ts';

const MINT = 'https://testnut.cashu.space';
const sender = new Wallet(MINT);
await sender.loadMint();

const quote = await sender.createMintQuoteBolt11(100);
for (let i = 0; i < 20; i++) {
  const q = await sender.checkMintQuoteBolt11(quote.quote);
  if (q.state === MintQuoteState.PAID) break;
  await new Promise((r) => setTimeout(r, 500));
}
const proofs = await sender.mintProofsBolt11(100, quote.quote);
console.log('minted', proofs.length, 'proofs; first:', JSON.stringify(proofs[0]).slice(0, 300));

const preview = await sender.ops.send(10, proofs).includeFees(true).prepare();
console.log('fees', String(preview.fees), 'unselected', preview.unselectedProofs?.length ?? 0);
const stored = JSON.stringify(serializeSwapPreview(preview));
const { keep, send } = await sender.completeSwap(deserializeSwapPreview(JSON.parse(stored)));
const sum = (ps: any[]) => ps.reduce((s, p) => s + Number(p.amount), 0);
console.log('send', sum(send), 'sats in', send.length, '; keep', sum(keep), '; unselected', sum(preview.unselectedProofs ?? []));
console.log('send[0] keys', Object.keys(send[0]), 'amount type', typeof send[0].amount, String(send[0].amount));

// Replay the same preview (NUT-19 cache): should return the same signatures
const replay = await sender.completeSwap(deserializeSwapPreview(JSON.parse(stored)));
console.log('replay same C:', replay.send[0].C === send[0].C);

// Receiver: swap the proofs at the mint
const receiver = new Wallet(MINT);
await receiver.loadMint();
const wire = JSON.parse(JSON.stringify(send.map((p: any) => ({ ...p, amount: Number(p.amount) }))));
const got = await receiver.ops.receive(wire).run();
console.log('receiver got', sum(got));
try {
  await receiver.ops.receive(wire).run();
  console.log('second receive: no error?!');
} catch (e: any) {
  console.log('second receive error:', e?.constructor?.name, e?.code, e?.status, String(e?.message).slice(0, 200));
}
process.exit(0);
