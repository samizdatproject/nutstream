// Live check of the persisted mint path on the test mint: prepare -> complete -> replay -> restore.
import { CashuLedger } from '../src/core/ledger.ts';
const l = new CashuLedger('https://testnut.cashu.space');
const inv = await l.createInvoice(50);
for (let i = 0; i < 20 && (await l.quoteState(inv.quote)) === 'UNPAID'; i++) await new Promise((r) => setTimeout(r, 500));
const pv = await l.prepareMint(inv.quote, 50);
const stored = JSON.parse(JSON.stringify(pv)); // through JSON, as IndexedDB would
const a = await l.completeMint(stored);
console.log('minted', a.reduce((s, p) => s + p.amount, 0), 'state now', await l.quoteState(inv.quote));
let replay; try { replay = await l.completeMint(stored); } catch (e: any) { replay = `error: ${e.message}`; }
console.log('replay', typeof replay === 'string' ? replay : replay.map((p) => p.C).join() === a.map((p) => p.C).join() ? 'same proofs' : 'DIFFERENT');
const r = await l.restoreMint(stored);
console.log('restore', r && r.map((p) => p.C).join() === a.map((p) => p.C).join() ? 'same proofs' : r);
process.exit(0);
