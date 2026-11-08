import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { coinIdFromReceipt, createCoinTx, readIdentityTaken, readLaunchFee } from '../lib/evm';
import { syncChain } from '../lib/sync';
import { absoluteRpcUrl } from '../lib/solana';
import { useApp } from '../lib/app';
import type { ChainId, LaunchCostQuote } from '../lib/types';
import { clsx, fmtCompact, fmtNum, fmtUsd, usdOf } from '../lib/format';
import { CHAINS, TOTAL_SUPPLY, initialState, quoteBuy, toBase } from '../../shared/market';
import { ChainBadge, CoinAvatar } from '../components/Brand';
import { Modal } from '../components/Header';
import { ICheck, IImage, IShield, IX, ILock } from '../components/Icons';

const NAME_MAX = 32;
const DESC_MAX = 500;

function isUrlLike(v: string) {
  if (!v) return true;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    return u.hostname.includes('.');
  } catch {
    return false;
  }
}
const isHandleOrUrl = (v: string) => !v || /^@?[A-Za-z0-9_]{1,40}$/.test(v) || /^https?:\/\//i.test(v);

export default function Create() {
  const { config, ensureAuth, prices, chain, evmCfg, evmName, evmAddress, solAddress, ensureChainWallet, nativeBalances } = useApp();
  const limits = config?.limits;

  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [description, setDescription] = useState('');
  const [website, setWebsite] = useState('');
  const [twitter, setTwitter] = useState('');
  const [telegram, setTelegram] = useState('');
  const [more, setMore] = useState(false);
  const [imageData, setImageData] = useState<string | null>(null);
  const [imageErr, setImageErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [chains, setChains] = useState<Set<ChainId>>(new Set(['sol', 'hyp']));
  // the start market cap is one of the tiers the contract offers (read from the chain by the server)
  const hypCfg = config?.chains.find((c) => c.id === 'hyp');
  const tierList = useMemo(() => hypCfg?.startMcapTiers ?? CHAINS.hyp.startMcapTiers ?? [], [hypCfg]);
  const [pickedMcap, setPickedMcap] = useState<number | null>(null);
  const startMcap = pickedMcap !== null && tierList.includes(pickedMcap) ? pickedMcap : (hypCfg?.startMcap ?? tierList[0] ?? 0);
  const [buySol, setBuySol] = useState('');
  const [buyHyp, setBuyHyp] = useState('');
  const [feeMode, setFeeMode] = useState<'creator' | 'holders'>('creator');
  const [touched, setTouched] = useState(false);

  const [cost, setCost] = useState<LaunchCostQuote | null>(null);
  const [liveRun, setLiveRun] = useState(false);
  const [hypFee, setHypFee] = useState<number | null>(null);
  const [identityTaken, setIdentityTaken] = useState(false);

  useEffect(() => {
    document.title = 'Launch a coin | Elytheia';
  }, []);

  // the EVM chain can only be selected once the Launchpad contract is deployed and configured on this site
  useEffect(() => {
    if (config && !evmCfg) {
      setChains((cur) => {
        if (!cur.has('hyp')) return cur;
        const n = new Set(cur);
        n.delete('hyp');
        return n;
      });
    }
  }, [config, evmCfg]);

  const sym = symbol.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const errors = {
    name: !name.trim() ? 'Give your coin a name' : name.length > NAME_MAX ? 'Too long' : '',
    symbol: sym.length < 2 ? 'Ticker needs 2–10 letters or numbers' : sym.length > 10 ? 'Too long' : '',
    website: !isUrlLike(website.trim()) ? 'Enter a valid link' : '',
    twitter: !isHandleOrUrl(twitter.trim()) ? 'Use a handle or a link' : '',
    telegram: !isHandleOrUrl(telegram.trim()) ? 'Use a handle or a link' : '',
    chains: chains.size === 0 ? 'Select at least one chain' : '',
    feeMode: feeMode === 'holders' && chains.has('hyp') ? `Holder rewards work on Solana only. Pick Creator fees, or untick ${evmName}.` : '',
  };
  const valid = !Object.values(errors).some(Boolean);

  const firstBuy = useMemo(() => ({ sol: Number(buySol) || 0, hyp: Number(buyHyp) || 0 }), [buySol, buyHyp]);
  const hasHyp = chains.has('hyp');
  const hasSol = chains.has('sol');

  // ---- live network: costs come straight from the chain, not from the server
  useEffect(() => {
    if (!evmCfg) return;
    readLaunchFee(evmCfg).then((w) => setHypFee(Number(w) / 1e18)).catch(() => setHypFee(null));
  }, [evmCfg]);

  useEffect(() => {
    if (!evmCfg || !hasHyp || !name.trim() || sym.length < 2) {
      setIdentityTaken(false);
      return;
    }
    const t = setTimeout(() => readIdentityTaken(evmCfg, name.trim(), sym).then(setIdentityTaken).catch(() => {}), 350);
    return () => clearTimeout(t);
  }, [evmCfg, hasHyp, name, sym]);

  useEffect(() => {
    const lines: LaunchCostQuote['lines'] = [];
    let needHype = 0;
    let needSol = 0;
    if (hasHyp) {
      const fee = hypFee ?? chain('hyp').launchFee;
      lines.push({ label: `${evmName} launch fee`, chain: 'hyp', asset: 'HYPE', amount: fee });
      if (firstBuy.hyp > 0) lines.push({ label: `First buy on ${evmName}`, chain: 'hyp', asset: 'HYPE', amount: firstBuy.hyp });
      needHype = fee + firstBuy.hyp;
    }
    if (hasSol) {
      lines.push({ label: 'Solana rent & network fees (≈)', chain: 'sol', asset: 'SOL', amount: 0.025 });
      if (firstBuy.sol > 0) lines.push({ label: 'First buy on Solana', chain: 'sol', asset: 'SOL', amount: firstBuy.sol });
      needSol = 0.025 + firstBuy.sol;
    }
    const gas = 0.02; // headroom for EVM gas and Solana priority fees
    setCost({
      lines,
      chargeSol: needSol,
      chargeHype: needHype,
      needSol,
      needHype,
      canAfford:
        (!hasHyp || (nativeBalances.hype ?? 0) >= needHype + gas) && (!hasSol || (nativeBalances.sol ?? 0) >= needSol + gas),
      antivamp: identityTaken ? `AntiVamp: a coin with this name and ticker already exists on ${evmName}.` : null,
    });
  }, [hasHyp, hasSol, hypFee, firstBuy.hyp, firstBuy.sol, identityTaken, nativeBalances.hype, nativeBalances.sol, chain]);

  // estimate what the first buy gets you (same maths the contract uses; pump.fun's fee is slightly higher, so ≈)
  const estimate = useCallback(
    (id: ChainId, amount: number) => {
      if (!amount) return null;
      const c = id === 'hyp' ? { ...CHAINS.hyp, startMcapTiers: tierList } : CHAINS[id];
      const st = initialState(c, id === 'hyp' ? startMcap : undefined);
      const q = quoteBuy(c, st, toBase(amount), c.baseFeeBps);
      if (!q.ok) return null;
      return { tokens: q.tokensOut / 1e6, pct: (q.tokensOut / TOTAL_SUPPLY) * 100 };
    },
    [startMcap, tierList],
  );
  const estSol = estimate('sol', firstBuy.sol);
  const estHyp = estimate('hyp', firstBuy.hyp);
  const maxPct = limits?.maxCreatorBuyPct ?? 20;
  const overCap = (hasSol && (estSol?.pct ?? 0) > maxPct) || (hasHyp && (estHyp?.pct ?? 0) > maxPct);

  const toggleChain = (id: ChainId) =>
    setChains((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const pickFile = (file: File | undefined | null) => {
    setImageErr(null);
    if (!file) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return setImageErr('Use a PNG, JPG, GIF or WebP image');
    if (file.size > (limits?.maxImageBytes ?? 1_500_000)) return setImageErr(`Image is too large (max ${((limits?.maxImageBytes ?? 1_500_000) / 1_000_000).toFixed(1)} MB)`);
    const r = new FileReader();
    r.onload = () => setImageData(String(r.result));
    r.onerror = () => setImageErr('Could not read that file');
    r.readAsDataURL(file);
  };

  // The Solana half needs this site on a public https address: the metadata link is permanent on-chain
  const solReady = /^https:\/\//i.test(config?.publicUrl ?? '');
  const solBlocked = hasSol && !solReady;

  const submit = () => {
    setTouched(true);
    if (!valid || overCap || solBlocked) return;
    // every selected chain needs its own wallet; connecting one also signs you in (for the metadata upload)
    for (const c of chains) if (!ensureChainWallet(c)) return;
    if (!ensureAuth()) return;
    setLiveRun(true);
  };

  const chargeText = cost
    ? [cost.chargeSol > 0 ? `${fmtNum(cost.chargeSol, 4)} SOL` : '', cost.chargeHype > 0 ? `${fmtNum(cost.chargeHype, 4)} HYPE` : ''].filter(Boolean).join(' + ') || 'Free'
    : '–';
  const haveWallets = [...chains].every((c) => (c === 'hyp' ? !!evmAddress : !!solAddress));
  const usdTotal = cost && !(cost.chargeSol > 0 && !prices.SOL) && !(cost.chargeHype > 0 && !prices.HYPE)
    ? cost.chargeSol * prices.SOL + cost.chargeHype * prices.HYPE
    : null;

  const previewCoin = { symbol: sym || 'TICK', image: imageData };

  return (
    <div className="page narrow" style={{ maxWidth: 1100 }}>
      <div className="page-title">
        <h2>Launch a coin</h2>
      </div>
      <p className="muted" style={{ margin: '0 0 22px' }}>
        Launch on Solana and {evmName} from one form. You confirm one transaction per chain in your wallet.
      </p>

      <div className="create-grid">
        <div>
          {/* identity */}
          <div className="card" style={{ marginBottom: 14 }}>
            <h3>Coin details</h3>
            <div className="field">
              <label className="label">Image <span className="opt">PNG, JPG, GIF or WebP · max 1.5 MB</span></label>
              <div
                className={clsx('dropzone', over && 'over')}
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setOver(true); }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => { e.preventDefault(); setOver(false); pickFile(e.dataTransfer.files?.[0]); }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileRef.current?.click()}
                aria-label="Upload coin image"
              >
                {imageData ? <CoinAvatar coin={previewCoin} size={64} /> : <span className="avatar" style={{ width: 64, height: 64, background: '#efe8d6', color: '#8a6420' }}><IImage size={26} /></span>}
                <div className="grow">
                  <b>{imageData ? 'Looking good' : 'Drop an image or click to browse'}</b>
                  <div className="muted small">Square images work best. Leave empty for a generated avatar.</div>
                </div>
                {imageData && (
                  <button type="button" className="icon-btn" aria-label="Remove image" onClick={(e) => { e.stopPropagation(); setImageData(null); if (fileRef.current) fileRef.current.value = ''; }}>
                    <IX size={16} />
                  </button>
                )}
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => pickFile(e.target.files?.[0])} />
              </div>
              {imageErr && <div className="err small">{imageErr}</div>}
            </div>

            <div className="row gap wrap" style={{ alignItems: 'flex-start' }}>
              <div className="field grow" style={{ minWidth: 220 }}>
                <label className="label" htmlFor="c-name">Name <span className="counter">{name.length}/{NAME_MAX}</span></label>
                <input id="c-name" className={clsx('input', touched && errors.name && 'bad')} maxLength={NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} placeholder="Gigachad Sloth" autoComplete="off" />
                {touched && errors.name && <div className="err small" style={{ margin: 0 }}>{errors.name}</div>}
              </div>
              <div className="field" style={{ width: 170 }}>
                <label className="label" htmlFor="c-sym">Ticker</label>
                <div className="input-group prefix">
                  <span className="pre">$</span>
                  <input id="c-sym" className={clsx('input', touched && errors.symbol && 'bad')} maxLength={10} value={symbol} onChange={(e) => setSymbol(e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase())} placeholder="SLOTH" autoComplete="off" />
                </div>
                {touched && errors.symbol && <div className="err small" style={{ margin: 0 }}>{errors.symbol}</div>}
              </div>
            </div>

            <div className="field">
              <label className="label" htmlFor="c-desc">Description <span className="opt">optional · <span className="counter">{description.length}/{DESC_MAX}</span></span></label>
              <textarea id="c-desc" className="textarea" maxLength={DESC_MAX} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this coin about?" />
            </div>

            <button type="button" className="linkish small" onClick={() => setMore(!more)}>
              {more ? '− Hide links' : '+ Add website & socials'}
            </button>
            {more && (
              <div className="mt-sm">
                <div className="field">
                  <label className="label" htmlFor="c-web">Website</label>
                  <input id="c-web" className={clsx('input', errors.website && 'bad')} value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://yourcoin.xyz" />
                  {errors.website && <div className="err small" style={{ margin: 0 }}>{errors.website}</div>}
                </div>
                <div className="row gap wrap">
                  <div className="field grow" style={{ minWidth: 200 }}>
                    <label className="label" htmlFor="c-x">X / Twitter</label>
                    <input id="c-x" className={clsx('input', errors.twitter && 'bad')} value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="@handle or link" />
                    {errors.twitter && <div className="err small" style={{ margin: 0 }}>{errors.twitter}</div>}
                  </div>
                  <div className="field grow" style={{ minWidth: 200 }}>
                    <label className="label" htmlFor="c-tg">Telegram</label>
                    <input id="c-tg" className={clsx('input', errors.telegram && 'bad')} value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="handle or link" />
                    {errors.telegram && <div className="err small" style={{ margin: 0 }}>{errors.telegram}</div>}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* chains */}
          <div className="card" style={{ marginBottom: 14 }}>
            <h3>Where it launches</h3>
            <div className="chain-opts" role="group" aria-label="Chains">
              {(['sol', 'hyp'] as ChainId[]).map((id) => {
                const c = chain(id);
                const on = chains.has(id);
                const unavailable = id === 'hyp' && !evmCfg;
                return (
                  <button
                    key={id}
                    type="button"
                    className={clsx('opt-card', on && 'on')}
                    onClick={() => !unavailable && toggleChain(id)}
                    aria-pressed={on}
                    disabled={unavailable}
                    style={unavailable ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
                  >
                    <span className="check">{on && <ICheck size={13} />}</span>
                    <ChainBadge chain={id} />
                    <h4>{c.venue}</h4>
                    <p>{id === 'sol' ? "Launches through pump.fun's own program on Solana mainnet. Graduates to an AMM pool at 85 SOL raised." : c.blurb}</p>
                    <p style={{ marginTop: 6 }}>
                      {unavailable ? (
                        <b style={{ color: 'var(--muted)' }}>Not deployed on this site yet</b>
                      ) : (
                        <>Launch fee <b style={{ color: c.launchFee === 0 ? 'var(--green)' : 'var(--ink)' }}>{c.launchFee === 0 || id === 'sol' ? 'Free' : `${c.launchFee} ${c.quote}`}</b></>
                      )}
                    </p>
                  </button>
                );
              })}
            </div>
            {touched && errors.chains && <div className="err small">{errors.chains}</div>}

            {hasHyp && (
              <div className="field mt">
                <label className="label">{evmName} start market cap <span className="opt">{fmtUsd(usdOf(startMcap, prices.HYPE))}</span></label>
                <div className="tiers">
                  {tierList.map((t) => (
                    <button key={t} type="button" className={clsx('chip', startMcap === t && 'on')} onClick={() => setPickedMcap(t)}>
                      {fmtNum(t, t % 1 ? 1 : 0)} HYPE
                    </button>
                  ))}
                </div>
                <div className="hint">
                  {tierList.length > 1 ? 'A lower start means each HYPE buys more of the supply. ' : 'Every launch on this chain starts here. '}
                  It can't be changed after launch.
                </div>
              </div>
            )}
          </div>

          {/* first buy */}
          <div className="card" style={{ marginBottom: 14 }}>
            <h3>First buy <span className="muted" style={{ fontWeight: 500 }}>· optional</span></h3>
            <p className="muted small" style={{ marginTop: -6 }}>
              Be the first holder. Up to {maxPct}% of supply per chain; executes in the same launch, ahead of anyone else.
            </p>
            <div className="row gap wrap">
              {hasSol && (
                <div className="field grow" style={{ minWidth: 220 }}>
                  <label className="label" htmlFor="b-sol">On Solana</label>
                  <div className="input-group">
                    <input id="b-sol" className="input" inputMode="decimal" placeholder="0.0" value={buySol} onChange={(e) => setBuySol(e.target.value.replace(/[^0-9.]/g, ''))} />
                    <span className="suffix">SOL</span>
                  </div>
                  <div className={clsx('hint', (estSol?.pct ?? 0) > maxPct && 'down')}>
                    {estSol ? `≈ ${fmtCompact(estSol.tokens)} $${sym || 'TICK'} (${estSol.pct.toFixed(2)}% of supply)` : 'Skip to launch without buying'}
                  </div>
                </div>
              )}
              {hasHyp && (
                <div className="field grow" style={{ minWidth: 220 }}>
                  <label className="label" htmlFor="b-hyp">On {evmName}</label>
                  <div className="input-group">
                    <input id="b-hyp" className="input" inputMode="decimal" placeholder="0.0" value={buyHyp} onChange={(e) => setBuyHyp(e.target.value.replace(/[^0-9.]/g, ''))} />
                    <span className="suffix">HYPE</span>
                  </div>
                  <div className={clsx('hint', (estHyp?.pct ?? 0) > maxPct && 'down')}>
                    {estHyp ? `≈ ${fmtCompact(estHyp.tokens)} $${sym || 'TICK'} (${estHyp.pct.toFixed(2)}% of supply)` : 'Skip to launch without buying'}
                  </div>
                </div>
              )}
            </div>
            {overCap && <div className="err small">A first buy can't take more than {maxPct}% of supply on a chain.</div>}
          </div>

          {/* rewards + pay */}
          <div className="card">
            <h3>Fees & payment</h3>
            <div className="field">
              <label className="label">Trading-fee rewards</label>
              <div className="chain-opts">
                <button type="button" className={clsx('opt-card', feeMode === 'creator' && 'on')} onClick={() => setFeeMode('creator')} aria-pressed={feeMode === 'creator'}>
                  <span className="check">{feeMode === 'creator' && <ICheck size={13} />}</span>
                  <h4 style={{ marginTop: 0 }}>Creator fees</h4>
                  <p>{hasSol && !hasHyp ? 'pump.fun pays you 0.30% of every trade. Claim it anytime.' : `half of the 1% pool fee on every trade goes to you on ${evmName} (pump.fun pays 0.30% on Solana). Claim anytime.`}</p>
                </button>
                <button type="button" className={clsx('opt-card', feeMode === 'holders' && 'on')} onClick={() => setFeeMode('holders')} aria-pressed={feeMode === 'holders'}>
                  <span className="check">{feeMode === 'holders' && <ICheck size={13} />}</span>
                  <h4 style={{ marginTop: 0 }}>Holder rewards</h4>
                  <p>Trading fees are shared across all holders instead of going to you. Solana (pump.fun) only.</p>
                </button>
              </div>
              {errors.feeMode && <div className="err small">{errors.feeMode}</div>}
            </div>
            <div className="notice blue small">
              Each chain is its own transaction, paid in that chain's own currency (HYPE on {evmName}, SOL on Solana). You confirm each one in your wallet.
              {hasSol && " Solana coins are created through pump.fun's real program, so pump.fun's own fees apply (0.95% protocol + 0.30% creator)."}
            </div>
          </div>
        </div>

        {/* summary */}
        <aside className="sticky-col" aria-label="Launch summary">
          <div className="card">
            <h3>Preview</h3>
            <div className="row gap">
              <CoinAvatar coin={previewCoin} size={56} />
              <div className="grow">
                <div className="trunc"><b>{name.trim() || 'Your coin'}</b> <span className="muted">${sym || 'TICK'}</span></div>
                <div className="row gap-sm wrap" style={{ marginTop: 4 }}>
                  {[...chains].map((id) => <ChainBadge key={id} chain={id} />)}
                  {feeMode === 'holders' && <span className="badge neutral">Holder rewards</span>}
                </div>
              </div>
            </div>
            <p className="small" style={{ margin: '12px 0 0', color: '#5e584c', wordBreak: 'break-word' }}>{description.trim() || 'Your description appears here.'}</p>
          </div>

          <div className="card">
            <h3>Cost</h3>
            {cost ? (
              <table className="cost-table">
                <tbody>
                  {cost.lines.map((l, i) => (
                    <tr key={i}>
                      <td>{l.label}</td>
                      <td className={l.amount === 0 ? 'up' : undefined}>{l.amount === 0 ? 'Free' : `${fmtNum(l.amount, 4)} ${l.asset}`}</td>
                    </tr>
                  ))}
                  <tr className="total">
                    <td>You pay</td>
                    <td>{chargeText}<div className="xs muted" style={{ fontWeight: 500 }}>≈ {fmtUsd(usdTotal, { precise: true })}</div></td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <div className="skeleton" style={{ height: 90 }} />
            )}
            {(evmAddress || solAddress) && (
              <div className="small muted mt-sm">
                Your balance: {evmAddress && `${nativeBalances.hype === null ? '…' : fmtNum(nativeBalances.hype, 3)} HYPE`}{evmAddress && solAddress && ' · '}{solAddress && `${nativeBalances.sol === null ? '…' : fmtNum(nativeBalances.sol, 3)} SOL`}
              </div>
            )}
            {cost?.canAfford === false && haveWallets && (
              <div className="notice red small mt-sm">Your connected wallet doesn't hold enough to cover this launch (including a little for network fees).</div>
            )}
            {solBlocked && (
              <div className="notice red small mt-sm">
                <b>Solana launches need this site on a public https address.</b> A pump.fun coin's metadata link is written on-chain and can never
                be changed, so launching from here would permanently break the coin's image and description. You can still launch on {evmName}{' '}
                only, and trade or import existing Solana coins from here.
              </div>
            )}
            {cost?.antivamp && name.trim() && sym.length >= 2 && (
              <div className="notice red small mt-sm"><IShield size={13} style={{ verticalAlign: -2 }} /> {cost.antivamp}</div>
            )}

            <button
              className="btn gold lg full mt"
              onClick={submit}
              disabled={solBlocked || (haveWallets && (cost?.canAfford === false || !!cost?.antivamp)) || chains.size === 0}
            >
              {haveWallets ? 'Launch coin' : 'Connect wallet to launch'}
            </button>
            <p className="xs muted center" style={{ margin: '10px 0 0' }}>
              <ILock size={11} style={{ verticalAlign: -1 }} /> Real transactions on live networks. Coins are permissionless; the {evmName} contracts are unaudited.
            </p>
          </div>
        </aside>
      </div>

      {liveRun && (
        <LiveLaunch
          spec={{
            name: name.trim(), symbol: sym, description: description.trim(), website: website.trim(), twitter: twitter.trim(),
            telegram: telegram.trim(), imageData, chains: [...chains], feeMode, startMcap, firstBuy,
          }}
          onClose={() => setLiveRun(false)}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------- live network launch */

interface LiveSpec {
  name: string;
  symbol: string;
  description: string;
  website: string;
  twitter: string;
  telegram: string;
  imageData: string | null;
  chains: ChainId[];
  feeMode: 'creator' | 'holders';
  startMcap: number;
  firstBuy: { sol: number; hyp: number };
}

type LiveStepKey = 'meta' | 'hyp' | 'sol';

/**
 * Orchestrates a real launch: publish metadata, then one wallet-signed transaction per chain. Each step is
 * idempotent once finished, so "Retry" after a rejected signature resumes where it stopped instead of repeating work
 * (and never creates a coin twice).
 */
function LiveLaunch({ spec, onClose }: { spec: LiveSpec; onClose: () => void }) {
  const app = useApp();
  const nav = useNavigate();
  const [steps, setSteps] = useState<{ key: LiveStepKey; label: string; state: 'pending' | 'active' | 'done' | 'error'; detail?: string }[]>(() => [
    { key: 'meta' as const, label: 'Publishing coin metadata', state: 'pending' as const },
    ...(spec.chains.includes('hyp') ? [{ key: 'hyp' as const, label: `Create on ${app.evmName} · confirm in your wallet`, state: 'pending' as const }] : []),
    ...(spec.chains.includes('sol') ? [{ key: 'sol' as const, label: 'Create on Solana (pump.fun) · confirm in your wallet', state: 'pending' as const }] : []),
  ]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const res = useRef<{ uri?: string; hypId?: string; solId?: string }>({});
  const started = useRef(false);

  const set = (key: LiveStepKey, patch: Partial<(typeof steps)[number]>) => setSteps((s) => s.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    let current: LiveStepKey = 'meta';
    try {
      // 1) metadata (image upload + public JSON). The URI is written on-chain and can never be changed.
      if (!res.current.uri) {
        set('meta', { state: 'active' });
        let image: string | null = null;
        if (spec.imageData) image = (await api<{ url: string }>('/upload', { body: { data: spec.imageData } })).url;
        const m = await api<{ uri: string }>('/chain/metadata', {
          body: { name: spec.name, symbol: spec.symbol, description: spec.description, image, website: spec.website, twitter: spec.twitter, telegram: spec.telegram },
        });
        res.current.uri = m.uri;
        set('meta', { state: 'done' });
      }
      const uri = res.current.uri!;

      // 2) EVM chain
      if (spec.chains.includes('hyp') && !res.current.hypId) {
        current = 'hyp';
        set('hyp', { state: 'active', detail: undefined });
        const cfg = app.evmCfg;
        const addr = app.evmAddress;
        if (!cfg || !addr) throw new Error('Connect your EVM wallet, then press Retry');
        const launchFeeWei = await readLaunchFee(cfg);
        const firstBuyWei = BigInt(Math.round(spec.firstBuy.hyp * 1e9)) * 1_000_000_000n;
        const { receipt } = await createCoinTx(cfg, addr, {
          name: spec.name, symbol: spec.symbol, metadataURI: uri, firstBuyWei, launchFeeWei,
        });
        const n = coinIdFromReceipt(receipt, cfg.launchpad!);
        if (n === null) throw new Error('The transaction succeeded but no coin was found in it');
        await syncChain();
        res.current.hypId = `hyp-${cfg.chainId}-${n}`;
        set('hyp', { state: 'done', detail: 'Coin created and liquidity locked' });
      }

      // 3) Solana via pump.fun
      if (spec.chains.includes('sol') && !res.current.solId) {
        current = 'sol';
        set('sol', { state: 'active', detail: undefined });
        if (!/^https:\/\//i.test(uri)) {
          throw new Error(
            'This site is not served from a public https address (PUBLIC_URL), and a pump.fun coin\'s metadata link is permanent. Launching now would give the coin an image and description that can never load. Nothing was spent.',
          );
        }
        if (!app.solAddress || !app.solWalletId || !app.config?.solana) throw new Error('Connect your Solana wallet, then press Retry');
        const [pump, web3, adapter] = await Promise.all([import('../lib/pump'), import('@solana/web3.js'), import('../lib/pumpAdapter')]);
        const conn = new web3.Connection(absoluteRpcUrl(app.config.solana.rpcUrl), 'confirmed');
        const ctx = await pump.loadPumpContext(conn);
        const user = new web3.PublicKey(app.solAddress);
        const prepared = await pump.prepareCreate(
          conn, ctx, user,
          { name: spec.name, symbol: spec.symbol, uri, holderRewards: spec.feeMode === 'holders' },
          BigInt(Math.round(spec.firstBuy.sol * 1e9)),
        );
        await adapter.preflight(conn, prepared.tx); // free dry-run against the real program
        const signature = await adapter.sendWithWallet(app.solWalletId, conn, prepared.tx);
        set('sol', { detail: 'Waiting for confirmation…' });
        await pump.confirm(conn, signature);
        // the server reads the chain itself; give its RPC a moment to see the transaction
        let id: string | null = null;
        for (let i = 0; i < 8 && !id; i++) {
          try {
            id = (await api<{ id: string }>('/chain/solana/register', { body: { signature } })).id;
          } catch (e) {
            if (i === 7) throw e;
            await new Promise((r) => setTimeout(r, 1500));
          }
        }
        res.current.solId = id!;
        set('sol', { state: 'done', detail: 'Coin is live on pump.fun' });
      }
      setDone(true);
      void app.refreshNativeBalances();
    } catch (e: any) {
      const msg = e?.message || 'Something went wrong';
      set(current, { state: 'error', detail: msg });
      setError(msg);
    } finally {
      setRunning(false);
    }
  }, [app, spec]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice in dev: never start two launches
    started.current = true;
    void run();
  }, [run]);

  const links = [
    res.current.hypId ? { id: res.current.hypId, label: app.evmName } : null,
    res.current.solId ? { id: res.current.solId, label: 'Solana' } : null,
  ].filter(Boolean) as { id: string; label: string }[];

  return (
    <Modal title={done ? '🎉 Your coin is live' : error ? 'Launch paused' : 'Launching…'} onClose={running ? () => {} : onClose}>
      <p className="muted small" style={{ margin: 0 }}>{spec.name} · ${spec.symbol}</p>
      <ul className="stages">
        {steps.map((s) => (
          <li key={s.key} className={clsx('stage', s.state)}>
            <span className="mark">
              {s.state === 'done' && <ICheck size={13} />}
              {s.state === 'active' && <span className="spinner" style={{ width: 12, height: 12 }} />}
              {s.state === 'error' && <IX size={13} />}
            </span>
            <div>
              <div className="t">{s.label}</div>
              {s.detail && <div className="d">{s.detail}</div>}
            </div>
          </li>
        ))}
      </ul>
      {error && !running && (
        <>
          <div className="notice red small">{error}</div>
          <div className="row gap mt-sm">
            <button className="btn gold grow" onClick={() => void run()}>Retry</button>
            <button className="btn ghost" onClick={onClose}>Close</button>
          </div>
          {links.length > 0 && <p className="xs muted" style={{ marginTop: 8 }}>A coin that was already created stays created: Retry only does the remaining steps.</p>}
        </>
      )}
      {done && (
        <div className="col" style={{ gap: 8, marginTop: 14 }}>
          {links.map((l) => (
            <button key={l.id} className="btn gold full" onClick={() => nav(`/coin/${l.id}`)}>Open on {l.label}</button>
          ))}
          <Link to="/home#coins" className="btn ghost full" onClick={onClose}>Back to all coins</Link>
        </div>
      )}
    </Modal>
  );
}
