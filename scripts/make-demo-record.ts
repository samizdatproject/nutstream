// Writes the demo feed's purpose="cashu" record (a NUT-18 request whose POST target is the in-page demo show).
import { readFileSync, writeFileSync } from 'node:fs';
import { makeCashuRecord } from '../src/core/discover.ts';
const { creq } = makeCashuRecord('https://demo-show.invalid/api/community/ecash-payment', 'nutstream demo show');
const p = new URL('../public/demo/feed.xml', import.meta.url);
writeFileSync(p, readFileSync(p, 'utf8').replace(/<podcast:txt purpose="cashu">[^<]*<\/podcast:txt>/, `<podcast:txt purpose="cashu">${creq}</podcast:txt>`));
console.log(creq);
