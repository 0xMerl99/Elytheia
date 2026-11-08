import bs58 from 'bs58';

export type WalletId = 'phantom' | 'solflare' | 'backpack';

export interface WalletOption {
  id: WalletId;
  name: string;
  installed: boolean;
  installUrl?: string;
  hint: string;
}

export interface WalletSession {
  id: WalletId;
  address: string;
  /** Signs a UTF-8 message and returns the base58 signature. */
  sign(message: string): Promise<string>;
}

const LAST_WALLET_KEY = 'elytheia.wallet';

function storageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function storageSet(k: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

export const rememberWallet = (id: WalletId | null) => storageSet(LAST_WALLET_KEY, id);
export const lastWallet = () => storageGet(LAST_WALLET_KEY) as WalletId | null;

function injected(id: WalletId): any | null {
  const w = window as any;
  switch (id) {
    case 'phantom':
      return w.phantom?.solana?.isPhantom ? w.phantom.solana : w.solana?.isPhantom ? w.solana : null;
    case 'solflare':
      return w.solflare?.isSolflare ? w.solflare : null;
    case 'backpack':
      return w.backpack?.isBackpack ? w.backpack : (w.xnft?.solana ?? null);
  }
}

/** The injected Solana provider object for a wallet id (used to sign and send transactions). */
export function getSolanaProvider(id: WalletId): any | null {
  return injected(id);
}

/** Reconnect without any prompt, but only if the wallet already trusts this site. Returns the address or null. */
export async function silentSolanaConnect(id: WalletId): Promise<string | null> {
  try {
    const p = injected(id);
    if (!p) return null;
    const r = await p.connect({ onlyIfTrusted: true });
    return (r?.publicKey ?? p.publicKey)?.toString() ?? null;
  } catch {
    return null;
  }
}

export function listWallets(): WalletOption[] {
  return [
    { id: 'phantom', name: 'Phantom', installed: !!injected('phantom'), installUrl: 'https://phantom.app/', hint: 'Solana wallet' },
    { id: 'solflare', name: 'Solflare', installed: !!injected('solflare'), installUrl: 'https://solflare.com/', hint: 'Solana wallet' },
    { id: 'backpack', name: 'Backpack', installed: !!injected('backpack'), installUrl: 'https://backpack.app/', hint: 'Solana wallet' },
  ];
}

/* ------------------------------------------------------------- connection */

export async function connectWallet(id: WalletId): Promise<WalletSession> {
  const provider = injected(id);
  if (!provider) throw new Error(`${id[0].toUpperCase()}${id.slice(1)} is not installed in this browser`);
  let address: string | undefined;
  try {
    const resp = await provider.connect();
    address = (resp?.publicKey ?? provider.publicKey)?.toString();
  } catch (e: any) {
    if (e?.code === 4001 || /reject|denied|cancel/i.test(String(e?.message))) {
      throw new Error('Connection request was declined');
    }
    throw e;
  }
  if (!address) throw new Error('The wallet did not return an address');

  return {
    id,
    address,
    sign: async (message) => {
      const bytes = new TextEncoder().encode(message);
      let res: any;
      try {
        res = await provider.signMessage(bytes, 'utf8');
      } catch (e: any) {
        if (e?.code === 4001 || /reject|denied|cancel/i.test(String(e?.message))) {
          throw new Error('Signature request was declined');
        }
        throw e;
      }
      const sig: Uint8Array = res?.signature ?? res;
      if (!(sig instanceof Uint8Array)) throw new Error('Wallet returned an unexpected signature');
      return bs58.encode(sig);
    },
  };
}

export async function disconnectWallet(id: WalletId | null) {
  if (!id) return;
  try {
    await injected(id)?.disconnect?.();
  } catch {
    /* ignore */
  }
}
