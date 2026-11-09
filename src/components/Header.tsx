import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useApp, type LoginId } from '../lib/app';
import type { Coin } from '../lib/types';
import { clsx, copyText, fmtNum, fmtUsd, shortAddr, usdOf } from '../lib/format';
import { listWallets, type WalletId } from '../lib/wallet';
import { hasEvmWallet } from '../lib/evm';
import { ChainBadge, CoinAvatar, Logo } from './Brand';
import { IChevDown, ICopy, ISearch, IUser, IWallet, IX, IDownload, IRocket } from './Icons';

/* ---------------------------------------------------------------- search */

const LOOKS_LIKE_SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function SearchBox({ sheet = false, onDone }: { sheet?: boolean; onDone?: () => void }) {
  const nav = useNavigate();
  const loc = useLocation();
  const { toast } = useApp();
  const [q, setQ] = useState('');
  const [coins, setCoins] = useState<Coin[]>([]);
  const [users, setUsers] = useState<{ address: string }[]>([]);
  const [searched, setSearched] = useState(false);
  const [open, setOpen] = useState(sheet);
  const [sel, setSel] = useState(-1);
  const [importing, setImporting] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (sheet) input.current?.focus();
  }, [sheet]);

  useEffect(() => {
    const term = q.trim();
    setSearched(false);
    if (!term) {
      setCoins([]);
      setUsers([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api<{ coins: Coin[]; users: { address: string }[] }>(`/search?q=${encodeURIComponent(term)}`, { signal: ctrl.signal })
        .then((r) => {
          setCoins(r.coins);
          setUsers(r.users);
          setSel(-1);
          setSearched(true);
        })
        .catch(() => {});
    }, 180);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  useEffect(() => {
    if (sheet) return;
    const onDoc = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [sheet]);

  useEffect(() => {
    if (!sheet) setOpen(false);
  }, [loc.pathname, sheet]);

  const term = q.trim();
  // A pasted Solana address that isn't listed yet can be added straight from the chain.
  const canImport = searched && coins.length === 0 && users.length === 0 && LOOKS_LIKE_SOLANA_ADDRESS.test(term);

  const results: { to: string }[] = [
    ...coins.map((c) => ({ to: `/coin/${c.id}` })),
    ...users.map((u) => ({ to: `/u/${u.address}` })),
  ];

  const go = (to: string) => {
    setOpen(false);
    setQ('');
    onDone?.();
    nav(to);
  };

  const importCoin = async () => {
    setImporting(true);
    try {
      const r = await api<{ id: string }>('/chain/solana/import', { body: { mint: term } });
      go(`/coin/${r.id}`);
    } catch (e: any) {
      toast(e.message || 'Could not import that token', 'err');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className={clsx('hsearch', sheet && 'sheet')} ref={box} role="search">
      <ISearch />
      <input
        ref={input}
        value={q}
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSel((s) => Math.min(results.length - 1, s + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSel((s) => Math.max(-1, s - 1));
          } else if (e.key === 'Escape') {
            setOpen(false);
          } else if (e.key === 'Enter') {
            if (sel >= 0 && results[sel]) go(results[sel].to);
            else if (canImport) void importCoin();
            else if (results[0]) go(results[0].to);
          }
        }}
        placeholder={sheet ? 'Search tokens, tickers or paste an address' : 'Search tokens'}
        aria-label="Search tokens"
      />
      {open && term && (
        <div className="search-pop">
          {coins.length === 0 && users.length === 0 && !canImport && searched && (
            <div className="muted small" style={{ padding: 12 }}>No matches for “{term}”.</div>
          )}
          {canImport && (
            <button className="search-import" onClick={importCoin} disabled={importing}>
              <span className="ico"><IDownload size={18} /></span>
              <span className="grow">
                <b>{importing ? 'Finding this token on Solana…' : 'Import this pump.fun token'}</b>
                <small className="muted" style={{ display: 'block' }}>
                  <span className="mono">{shortAddr(term, 8, 8)}</span> is not listed yet. We'll read it from the chain.
                </small>
              </span>
              {importing && <span className="spinner" />}
            </button>
          )}
          {coins.length > 0 && <div className="group">Tokens</div>}
          {coins.map((c, i) => (
            <Link key={c.id} to={`/coin/${c.id}`} className={clsx(sel === i && 'sel')} onClick={(e) => { e.preventDefault(); go(`/coin/${c.id}`); }}>
              <CoinAvatar coin={c} size={34} />
              <span className="grow trunc">
                <b>{c.name}</b> <span className="muted">${c.symbol}</span>
              </span>
              <ChainBadge chain={c.chain} />
              <span className="small muted">{fmtUsd(c.mcapUsd)}</span>
            </Link>
          ))}
          {users.length > 0 && <div className="group">Wallets</div>}
          {users.map((u, i) => (
            <Link key={u.address} to={`/u/${u.address}`} className={clsx(sel === coins.length + i && 'sel')} onClick={(e) => { e.preventDefault(); go(`/u/${u.address}`); }}>
              <IUser size={18} /> <span className="mono">{shortAddr(u.address, 6, 6)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** Phones and tablets: the search field lives in a full-screen sheet so it has room for results and the keyboard. */
function SearchSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  // portaled to <body>: the header's backdrop-filter would otherwise become the containing block of this fixed layer
  return createPortal(
    <div className="search-sheet" role="dialog" aria-modal="true" aria-label="Search">
      <div className="search-sheet-bar">
        <SearchBox sheet onDone={onClose} />
        <button className="icon-btn" onClick={onClose} aria-label="Close search"><IX size={22} /></button>
      </div>
    </div>,
    document.body,
  );
}

/* ---------------------------------------------------------------- header */

export function Header() {
  const { me, logout, openConnect, openWallets, toast, evmCfg, evmAddress, solAddress, nativeBalances } = useApp();
  const [menu, setMenu] = useState(false);
  const [searching, setSearching] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const nav = useNavigate();
  const loc = useLocation();
  const connected = !!(me || evmAddress || solAddress);
  const primary = me?.address ?? evmAddress ?? solAddress ?? '';
  const onHome = loc.pathname === '/home';

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => {
    setMenu(false);
    setSearching(false);
  }, [loc.pathname]);

  // the mobile tab bar's Search tab
  useEffect(() => {
    const open = () => setSearching(true);
    window.addEventListener('elyonpad:search', open);
    return () => window.removeEventListener('elyonpad:search', open);
  }, []);

  return (
    <header className="header">
      <div className="header-in">
        <Logo />
        <nav className="main-nav" aria-label="Main">
          <NavLink to="/home" className={() => (onHome ? 'on' : '')} end>Home</NavLink>
          <NavLink to="/create" className={({ isActive }) => (isActive ? 'on' : '')}>Launch</NavLink>
          <NavLink to="/profile" className={() => (loc.pathname.startsWith('/profile') || loc.pathname.startsWith('/u/') ? 'on' : '')}>Portfolio</NavLink>
          <NavLink to="/docs" className={({ isActive }) => (isActive ? 'on' : '')}>Docs</NavLink>
        </nav>
        <div className="header-right">
          <div className="hsearch-slot"><SearchBox /></div>
          <button className="icon-btn search-toggle" onClick={() => setSearching(true)} aria-label="Search">
            <ISearch size={22} />
          </button>
          <Link to="/create" className="btn outline-gold sm hide-xl"><IRocket size={15} /> Launch token</Link>
          {connected ? (
            <>
              <button className="balance-chip hide-lg" onClick={openWallets} title="Wallets" aria-label="Open wallet balances">
                <IWallet size={15} />
                {evmAddress && <span>{nativeBalances.hype === null ? '…' : fmtNum(nativeBalances.hype, 3)} HYPE</span>}
                {evmAddress && solAddress && <span style={{ opacity: 0.5 }}>·</span>}
                {solAddress && <span>{nativeBalances.sol === null ? '…' : fmtNum(nativeBalances.sol, 3)} SOL</span>}
              </button>
              <span className="connect-wrap" ref={wrap}>
                <button className="btn dark sm addr-btn" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>
                  <span className="dot" style={{ color: 'var(--green)' }} />
                  <span className="mono">{shortAddr(primary)}</span> <IChevDown size={14} />
                </button>
                {menu && (
                  <div className="menu" role="menu">
                    <div className="menu-note small">
                      <div className="muted xs" style={{ marginBottom: 6 }}>Connected wallets</div>
                      {evmAddress && (
                        <div className="row gap-sm">
                          <span className="badge hyp">EVM</span>
                          <span className="mono trunc grow">{shortAddr(evmAddress, 8, 6)}</span>
                          <button className="copy" aria-label="Copy EVM address" onClick={async () => toast((await copyText(evmAddress)) ? 'Address copied' : 'Copy failed', 'info')}><ICopy size={12} /></button>
                        </div>
                      )}
                      {solAddress && (
                        <div className="row gap-sm" style={{ marginTop: 6 }}>
                          <span className="badge sol">Solana</span>
                          <span className="mono trunc grow">{shortAddr(solAddress, 8, 6)}</span>
                          <button className="copy" aria-label="Copy Solana address" onClick={async () => toast((await copyText(solAddress)) ? 'Address copied' : 'Copy failed', 'info')}><ICopy size={12} /></button>
                        </div>
                      )}
                      {!(evmAddress && solAddress) && (evmCfg || !evmAddress) && (
                        <button className="linkish xs" style={{ marginTop: 8 }} onClick={() => { setMenu(false); openConnect(evmAddress ? 'sol' : evmCfg ? 'hyp' : 'sol'); }}>
                          + Connect {evmAddress ? 'a Solana' : evmCfg ? 'an EVM' : 'a Solana'} wallet
                        </button>
                      )}
                    </div>
                    <button onClick={() => { setMenu(false); openWallets(); }}><IWallet size={17} /> Wallet &amp; balances</button>
                    <button onClick={() => { setMenu(false); nav(`/u/${primary}`); }}><IUser size={17} /> Portfolio &amp; rewards</button>
                    <button onClick={() => { setMenu(false); void logout(); }}><IX size={17} /> Disconnect</button>
                  </div>
                )}
              </span>
            </>
          ) : (
            <button className="btn cyan sm connect-btn" onClick={() => openConnect()}>
              <IWallet size={16} /> <span>Connect<span className="hide-sm"> wallet</span></span>
            </button>
          )}
        </div>
      </div>
      {searching && <SearchSheet onClose={() => setSearching(false)} />}
    </header>
  );
}

/* ----------------------------------------------------------------- modal */

export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} tabIndex={-1} className={clsx('modal', wide && 'wide')} role="dialog" aria-modal="true" aria-label={title}>
        <button className="icon-btn modal-x" onClick={onClose} aria-label="Close">
          <IX size={20} />
        </button>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- connect modal */

const WALLET_COLORS: Record<string, string> = { phantom: '#ab9ff2', solflare: '#fc8c1c', backpack: '#e33e3f' };

/**
 * Phones have no browser extensions: a wallet is only reachable from inside its own app's browser. These are the wallets'
 * public "open this page in the app" universal links, used instead of the install page when the browser is a phone's.
 */
const IS_MOBILE = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const deepLinks = {
  phantom: () => `https://phantom.app/ul/browse/${encodeURIComponent(location.href)}?ref=${encodeURIComponent(location.origin)}`,
  solflare: () => `https://solflare.com/ul/v1/browse/${encodeURIComponent(location.href)}?ref=${encodeURIComponent(location.origin)}`,
  evm: () => `https://metamask.app.link/dapp/${location.host}${location.pathname}${location.search}`,
} as const;

export function ConnectModal() {
  const { connectOpen, closeConnect, login, connectFor, evmCfg, evmName, config } = useApp();
  const [busy, setBusy] = useState<LoginId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (connectOpen) setError(null);
  }, [connectOpen]);

  if (!connectOpen) return null;
  const wallets = listWallets();
  // when opened for a specific chain only show wallets that can trade it
  const showEvm = connectFor !== 'sol';
  const showSol = connectFor !== 'hyp';

  const go = async (id: LoginId) => {
    setBusy(id);
    setError(null);
    try {
      await login(id);
    } catch (e: any) {
      setError(e?.message || 'Could not connect');
    } finally {
      setBusy(null);
    }
  };

  const open = (id: WalletId, installed: boolean, installUrl?: string) => {
    if (installed) return void go(id);
    const link = id in deepLinks && IS_MOBILE ? deepLinks[id as 'phantom' | 'solflare']() : null;
    if (link) window.location.href = link;
    else window.open(installUrl, '_blank', 'noopener');
  };

  return (
    <Modal title="Connect a wallet" onClose={closeConnect}>
      <p className="muted small" style={{ margin: '0 0 4px' }}>
        Pick the wallet you want to use. Signing in only asks for a free message signature; every trade is a separate transaction you approve.
      </p>
      <div className="wallet-list">
        {showEvm && (
          <button
            className="wallet-btn"
            disabled={!!busy || !evmCfg}
            onClick={() => {
              if (hasEvmWallet()) void go('evm');
              else if (IS_MOBILE) window.location.href = deepLinks.evm();
              else window.open('https://metamask.io/download/', '_blank', 'noopener');
            }}
          >
            <span className="ico" style={{ background: '#0f6f8c' }}>E</span>
            <span className="grow">
              EVM wallet
              <small>
                {!evmCfg
                  ? `${evmName} launchpad is not deployed on this site yet`
                  : hasEvmWallet()
                    ? `Detected · connects to ${config?.evm?.name}`
                    : IS_MOBILE
                      ? 'MetaMask, Rabby… · open this site in your wallet app'
                      : 'MetaMask, Rabby, Coinbase… · none detected, get one'}
              </small>
            </span>
            {busy === 'evm' && <span className="spinner" />}
          </button>
        )}
        {showSol &&
          wallets.map((w) => (
            <button key={w.id} className="wallet-btn" disabled={!!busy} onClick={() => open(w.id, w.installed, w.installUrl)}>
              <span className="ico" style={{ background: WALLET_COLORS[w.id] }}>{w.name[0]}</span>
              <span className="grow">
                {w.name}
                <small>
                  {w.installed
                    ? 'Detected · tap to connect'
                    : IS_MOBILE && w.id !== 'backpack'
                      ? `Open this site in the ${w.name} app`
                      : 'Not installed · get it'}
                </small>
              </span>
              {busy === w.id && <span className="spinner" />}
            </button>
          ))}
      </div>
      {error && <div className="err small">{error}</div>}
      <div className="notice small" style={{ marginTop: 14 }}>
        <b>Live networks.</b> Transactions are real and can't be undone. The {evmName} contracts are unaudited, so only use funds you can afford to lose.
      </div>
    </Modal>
  );
}

/* ----------------------------------------------------------- wallet modal */

export function WalletModal() {
  const { walletsOpen, closeWallets, evmAddress, solAddress, nativeBalances, prices, config, evmCfg, evmName, toast, refreshNativeBalances, openConnect } = useApp();
  if (!walletsOpen) return null;
  return (
    <Modal title="Your wallets" onClose={closeWallets} wide>
      <p className="muted small" style={{ margin: '0 0 14px' }}>
        You trade straight from your own wallets. There is no deposit, no custody and no in-app swap here: every transaction is signed by
        you and cannot be undone.
      </p>
      <div className="col" style={{ gap: 10 }}>
        <div className="card flat wallet-row">
          <div className="grow">
            <span className="badge hyp">{evmName}</span> {evmCfg && <span className="xs muted">chain {evmCfg.chainId}</span>}
            <div className="mono small wrap-any" style={{ marginTop: 8 }}>{evmAddress ?? (evmCfg ? 'Not connected' : 'Launchpad not deployed yet')}</div>
          </div>
          {evmAddress ? (
            <div className="wallet-bal">
              <b>{nativeBalances.hype === null ? '…' : fmtNum(nativeBalances.hype, 4)}</b> <span className="muted">HYPE</span>
              <div className="xs muted">{fmtUsd(usdOf(nativeBalances.hype ?? 0, prices.HYPE))}</div>
            </div>
          ) : (
            evmCfg && <button className="btn gold sm" onClick={() => { closeWallets(); openConnect('hyp'); }}>Connect</button>
          )}
        </div>
        <div className="card flat wallet-row">
          <div className="grow">
            <span className="badge sol">Solana</span> <span className="xs muted">{config?.solana?.cluster}</span>
            <div className="mono small wrap-any" style={{ marginTop: 8 }}>{solAddress ?? 'Not connected'}</div>
          </div>
          {solAddress ? (
            <div className="wallet-bal">
              <b>{nativeBalances.sol === null ? '…' : fmtNum(nativeBalances.sol, 4)}</b> <span className="muted">SOL</span>
              <div className="xs muted">{fmtUsd(usdOf(nativeBalances.sol ?? 0, prices.SOL))}</div>
            </div>
          ) : (
            <button className="btn gold sm" onClick={() => { closeWallets(); openConnect('sol'); }}>Connect</button>
          )}
        </div>
      </div>
      <div className="row between mt">
        <span className="xs muted">Balances refresh every 15 seconds.</span>
        <button className="linkish small" onClick={() => { void refreshNativeBalances(); toast('Balances refreshed'); }}>Refresh now</button>
      </div>
    </Modal>
  );
}
