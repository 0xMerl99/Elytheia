import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiFail, getToken, setToken, setUnauthorizedHandler } from './api';
import type { AppConfig, ChainId, ChainInfo, EvmConfig, Me, Prices } from './types';
import { connectWallet, disconnectWallet, lastWallet, rememberWallet, silentSolanaConnect, type WalletId } from './wallet';
import { connectEvm, evmSignMessage, readNativeBalance } from './evm';
import { solBalance } from './solana';

export interface Toast {
  id: number;
  text: string;
  kind: 'ok' | 'err' | 'info';
}

/** Wallet choices: the Solana wallets, plus any injected EVM wallet. */
export type LoginId = WalletId | 'evm';

interface AppCtx {
  config: AppConfig | null;
  /** The EVM chain config, or null while the Launchpad contract isn't deployed/configured yet. */
  evmCfg: EvmConfig | null;
  /** Display name of the EVM chain (from the server's config, e.g. "Elysium"), available even before the contract is deployed. */
  evmName: string;
  prices: Prices;
  /** The wallet that signed in (identity for comments and uploads). Trading is signed by the wallets themselves. */
  me: Me | null;
  booting: boolean;
  chain: (id: ChainId) => ChainInfo;
  /** USD value of a quote asset amount */
  usd: (amount: number, quote: 'SOL' | 'HYPE') => number;
  /** Connected wallet addresses and their native balances (null until loaded). */
  evmAddress: `0x${string}` | null;
  solAddress: string | null;
  solWalletId: WalletId | null;
  nativeBalances: { hype: number | null; sol: number | null };
  refreshNativeBalances: () => Promise<void>;
  /** Make sure a wallet for the given chain is connected; opens the connect dialog when it isn't. */
  ensureChainWallet: (chain: ChainId) => boolean;
  connectOpen: boolean;
  /** Optional filter: which kind of wallet the dialog was opened for. */
  connectFor: ChainId | null;
  openConnect: (forChain?: ChainId) => void;
  closeConnect: () => void;
  walletsOpen: boolean;
  openWallets: () => void;
  closeWallets: () => void;
  login: (id: LoginId) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
  toast: (text: string, kind?: Toast['kind']) => void;
  toasts: Toast[];
  dismissToast: (id: number) => void;
  /** Returns true when signed in; otherwise opens the connect dialog. */
  ensureAuth: () => boolean;
}

const Ctx = createContext<AppCtx | null>(null);

const FALLBACK_PRICES: Prices = { SOL: 0, HYPE: 0, updatedAt: 0 };
const EVM_FLAG = 'elytheia.evm';

export function AppProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [booting, setBooting] = useState(true);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectFor, setConnectFor] = useState<ChainId | null>(null);
  const [walletsOpen, setWalletsOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [evmAddress, setEvmAddress] = useState<`0x${string}` | null>(null);
  const [solAddress, setSolAddress] = useState<string | null>(null);
  const [solWalletId, setSolWalletId] = useState<WalletId | null>(null);
  const [nativeBalances, setNativeBalances] = useState<{ hype: number | null; sol: number | null }>({ hype: null, sol: null });
  const toastId = useRef(0);

  const evmCfg = config?.evm?.enabled ? config.evm : null;

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 6500 : 4200);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await api<AppConfig>('/config'));
    } catch {
      /* keep what we have */
    }
  }, []);

  const refreshMe = useCallback(async () => {
    if (!getToken()) {
      setMe(null);
      return;
    }
    try {
      const r = await api<{ user: Me }>('/me');
      setMe(r.user);
    } catch (e) {
      if (e instanceof ApiFail && e.status === 401) {
        setToken(null);
        setMe(null);
      }
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null);
      setMe(null);
    });
    (async () => {
      await Promise.all([loadConfig(), refreshMe()]);
      setBooting(false);
    })();
    const t = setInterval(loadConfig, 2 * 60_000);
    return () => clearInterval(t);
  }, [loadConfig, refreshMe]);

  /* ------------------------------------------- restore wallet connections */

  useEffect(() => {
    if (booting || !config) return;
    let cancelled = false;
    (async () => {
      // EVM: eth_accounts never prompts; it only returns accounts the user already approved for this site
      try {
        const provider = window.ethereum;
        if (provider && evmCfg && localStorage.getItem(EVM_FLAG) === '1') {
          const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
          if (!cancelled && accounts?.[0]) {
            const { getAddress } = await import('viem');
            setEvmAddress(getAddress(accounts[0]));
          }
        }
      } catch {
        /* ignore */
      }
      // Solana: only reconnect silently if the wallet already trusts this site
      const sw = lastWallet();
      if (sw) {
        const addr = await silentSolanaConnect(sw);
        if (!cancelled && addr) {
          setSolAddress(addr);
          setSolWalletId(sw);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [booting, config, evmCfg?.chainId]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------------------------------ native balances */

  const refreshNativeBalances = useCallback(async () => {
    const [hype, sol] = await Promise.all([
      evmAddress && evmCfg ? readNativeBalance(evmCfg, evmAddress).catch(() => null) : Promise.resolve(null),
      solAddress && config?.solana ? solBalance(config.solana.rpcUrl, solAddress).catch(() => null) : Promise.resolve(null),
    ]);
    setNativeBalances({ hype, sol });
  }, [evmAddress, solAddress, evmCfg, config?.solana]);

  useEffect(() => {
    void refreshNativeBalances();
    const t = setInterval(refreshNativeBalances, 15_000);
    return () => clearInterval(t);
  }, [refreshNativeBalances]);

  /* ------------------------------------------------------------- sign in */

  const login = useCallback(
    async (id: LoginId) => {
      const alreadySignedIn = !!getToken();
      // 1) connect the wallet
      let address: string;
      let sign: (m: string) => Promise<string>;
      if (id === 'evm') {
        if (!evmCfg) throw new Error('The EVM launchpad is not deployed on this site yet');
        const a = await connectEvm(evmCfg);
        address = a;
        sign = (m) => evmSignMessage(evmCfg, a, m);
        setEvmAddress(a);
        try { localStorage.setItem(EVM_FLAG, '1'); } catch { /* ignore */ }
      } else {
        const session = await connectWallet(id);
        address = session.address;
        sign = session.sign;
        setSolAddress(session.address);
        setSolWalletId(id);
        rememberWallet(id);
      }

      // 2) sign in (once). A second wallet connected while already signed in only adds trading access.
      if (!alreadySignedIn) {
        const n = await api<{ nonce: string; message: string }>('/auth/nonce', { body: { address } });
        const signature = await sign(n.message);
        const v = await api<{ token: string }>('/auth/verify', {
          body: { address, nonce: n.nonce, signature },
        });
        setToken(v.token);
        await refreshMe();
      }
      setConnectOpen(false);
      toast('Wallet connected', 'ok');
      void refreshNativeBalances();
    },
    [evmCfg, refreshMe, refreshNativeBalances, toast],
  );

  const logout = useCallback(async () => {
    const w = lastWallet();
    try {
      await api('/auth/logout', { body: {} });
    } catch {
      /* already invalid */
    }
    setToken(null);
    setMe(null);
    setEvmAddress(null);
    setSolAddress(null);
    setSolWalletId(null);
    setNativeBalances({ hype: null, sol: null });
    rememberWallet(null);
    try { localStorage.removeItem(EVM_FLAG); } catch { /* ignore */ }
    await disconnectWallet(w);
    toast('Disconnected', 'info');
  }, [toast]);

  const prices = config?.prices ?? FALLBACK_PRICES;

  const value = useMemo<AppCtx>(
    () => ({
      config,
      evmCfg,
      evmName: config?.chains.find((c) => c.id === 'hyp')?.name ?? 'EVM',
      prices,
      me,
      booting,
      chain: (id) => config?.chains.find((c) => c.id === id) ?? (FALLBACK_CHAINS[id] as ChainInfo),
      usd: (amount, quote) => amount * (quote === 'SOL' ? prices.SOL : prices.HYPE),
      evmAddress,
      solAddress,
      solWalletId,
      nativeBalances,
      refreshNativeBalances,
      ensureChainWallet: (c) => {
        const ok = c === 'hyp' ? !!evmAddress : !!solAddress;
        if (!ok) {
          setConnectFor(c);
          setConnectOpen(true);
        }
        return ok;
      },
      connectOpen,
      connectFor,
      openConnect: (forChain) => {
        setConnectFor(forChain ?? null);
        setConnectOpen(true);
      },
      closeConnect: () => setConnectOpen(false),
      walletsOpen,
      openWallets: () => setWalletsOpen(true),
      closeWallets: () => setWalletsOpen(false),
      login,
      logout,
      refreshMe,
      toast,
      toasts,
      dismissToast,
      ensureAuth: () => {
        if (me) return true;
        setConnectFor(null);
        setConnectOpen(true);
        return false;
      },
    }),
    [config, evmCfg, prices, me, booting, evmAddress, solAddress, solWalletId, nativeBalances, refreshNativeBalances, connectOpen, connectFor, walletsOpen, login, logout, refreshMe, toast, toasts, dismissToast],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

// Used only until /api/config has loaded.
const FALLBACK_CHAINS: Record<ChainId, Partial<ChainInfo>> = {
  sol: { id: 'sol', name: 'Solana', venue: 'Bonding curve', quote: 'SOL', model: 'curve', launchFee: 0, baseFeeBps: 100, creatorFeeBps: 50, graduationQuote: 85, antiSnipe: null, startMcapTiers: null, startMcap: 30, blurb: '' },
  hyp: { id: 'hyp', name: 'EVM', venue: 'Locked-liquidity pool', quote: 'HYPE', model: 'pool', launchFee: 0, baseFeeBps: 100, creatorFeeBps: 50, graduationQuote: 0, antiSnipe: null, startMcapTiers: [400, 800, 1600], startMcap: 800, blurb: '' },
};
