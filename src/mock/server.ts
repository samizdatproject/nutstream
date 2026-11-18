// The mock receiver over real HTTP, for tests and local development:
//   node --experimental-transform-types src/mock/server.ts   (listens on 127.0.0.1:8787)
import { createServer, type Server } from 'node:http';
import { MockReceiver } from './receiver.ts';

export function serve(receiver: MockReceiver, port = 0): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', async () => {
      const out = await receiver.handle({ method: req.method ?? 'GET', url: req.url ?? '/', body, client: req.socket.remoteAddress });
      res.writeHead(out.status, out.headers).end(out.body);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    const a = server.address() as { port: number };
    resolve({ server, url: `http://127.0.0.1:${a.port}/api/community/ecash-payment` });
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { cashuRedeem } = await import('./cashuRedeem.ts');
  const receiver = new MockReceiver({ acceptedMints: ['https://testnut.cashu.space'], redeem: cashuRedeem() });
  receiver.onReceive((r) => console.log(new Date(r.at).toISOString(), r.kind, r.amount, 'sats', r.memo));
  const { url } = await serve(receiver, 8787);
  console.log('mock show listening at', url);
}
