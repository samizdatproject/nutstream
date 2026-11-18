// Redeem incoming proofs at the mint (a real swap), as a show's server would.
import { Wallet, MintOperationError, NetworkError } from '@cashu/cashu-ts';
import { sumProofs, type WireProof } from '../core/types.ts';
import type { Redeem } from './receiver.ts';

/** `privkey`: for P2PK-locked proofs (route A), the show's wallet key. */
export function cashuRedeem(onProofs?: (proofs: unknown[]) => void, privkey?: string): Redeem {
  const wallets = new Map<string, Promise<Wallet>>();
  const walletFor = (mint: string) => {
    let w = wallets.get(mint);
    if (!w) {
      const wallet = new Wallet(mint, { unit: 'sat' });
      w = wallet.loadMint().then(() => wallet);
      w.catch(() => wallets.delete(mint)); // offline once: try again next time
      wallets.set(mint, w);
    }
    return w;
  };
  return async (mint: string, proofs: WireProof[]) => {
    const wallet = await walletFor(mint);
    try {
      const op = wallet.ops.receive(proofs as any);
      const fresh = await (privkey ? op.privkey(privkey) : op).run();
      onProofs?.(fresh);
      return { amount: sumProofs(fresh) };
    } catch (e) {
      if (e instanceof MintOperationError && e.code === 11001) return { spent: true as const };
      if (e instanceof NetworkError) throw e; // mint unreachable: the receiver answers "unsupported_mint"
      return { invalid: (e as Error)?.message ?? String(e) }; // the mint (or local checks) refused the proofs
    }
  };
}
