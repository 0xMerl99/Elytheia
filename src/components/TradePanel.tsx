import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../lib/app';
import { useTradeAdapter } from '../lib/trading';
import type { Coin, Quote } from '../lib/types';
import { clsx, fmtCompact, fmtNum, fmtPct, fmtQuote } from '../lib/format';
import { CoinAvatar } from './Brand';

const SLIP_KEY = 'elytheia.slippage';

function loadSlip(): number {
  try {
    const v = Number(localStorage.getItem(SLIP_KEY));
    return [100, 300, 500, 1000].includes(v) ? v : 500;
  } catch {
    return 500;
  }
}

export function TradePanel({ coin, onTraded, meRefreshKey }: { coin: Coin; onTraded: () => void; meRefreshKey: number }) {
  const { toast, chain } = useApp();
  const ad = useTradeAdapter(coin, meRefreshKey);
  const info = chain(coin.chain);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [pct, setPct] = useState<number | undefined>(undefined);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [slip, setSlip] = useState(loadSlip);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  // reset the form when switching coins
  useEffect(() => {
    setAmount('');
    setPct(undefined);
    setQuote(null);
  }, [coin.id]);

  const amt = Number(amount) || 0;
  const { held, balance } = ad;

  // debounced quote
  useEffect(() => {
    if (!amt && pct === undefined) {
      setQuote(null);
      return;
    }
    const my = ++seq.current;
    setQuoting(true);
    const t = setTimeout(async () => {
      try {
        const q = await ad.quote(side, amt, pct);
        if (my === seq.current) setQuote(q);
      } catch (e: any) {
        if (my === seq.current) setQuote({ ok: false, error: e.message });
      } finally {
        if (my === seq.current) setQuoting(false);
      }
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amt, pct, side, coin.id, coin.priceQuote, ad.kind, ad.ready, held]);

  const buyQuick = info.quote === 'SOL' ? [0.1, 0.5, 1] : [1, 5, 10];
  const insufficient = side === 'buy' ? ad.ready && amt > balance : ad.ready && pct === undefined && amt > held + 1e-9;
  const canSubmit = !busy && !!quote?.ok && !insufficient && (side === 'buy' ? amt >= 0.001 : true);

  const pickSlip = (v: number) => {
    setSlip(v);
    try {
      localStorage.setItem(SLIP_KEY, String(v));
    } catch {
      /* ignore */
    }
  };

  const submit = async () => {
    if (!ad.ready) return ad.connect();
    if (!quote?.ok) return;
    setBusy(true);
    try {
      const r = await ad.execute(side, amt, pct, quote, slip);
      toast(r.message, 'ok');
      if (r.graduated) toast(`🎓 $${coin.symbol} just graduated to the AMM!`, 'ok');
      setAmount('');
      setPct(undefined);
      setQuote(null);
      await ad.refresh();
      onTraded();
    } catch (e: any) {
      toast(e.message || 'Trade failed', 'err');
      void ad.refresh();
    } finally {
      setBusy(false);
    }
  };

  const feeNote = useMemo(() => {
    const f = quote?.feeBps;
    // the decaying anti-snipe surcharge only exists on the EVM pool (pump.fun's fee is simply higher than our base fee)
    if (coin.chain === 'hyp' && f && f > info.baseFeeBps) return `Anti-snipe fee ${(f / 100).toFixed(1)}% (decays to ${(info.baseFeeBps / 100).toFixed(1)}%)`;
    return null;
  }, [quote?.feeBps, info.baseFeeBps, coin.chain]);

  const walletName = coin.chain === 'hyp' ? 'EVM' : 'Solana';

  return (
    <div className="card panel">
      <div className="seg" role="tablist">
        <button className={clsx(side === 'buy' && 'on buy')} onClick={() => { setSide('buy'); setAmount(''); setPct(undefined); }} role="tab" aria-selected={side === 'buy'}>
          Buy
        </button>
        <button className={clsx(side === 'sell' && 'on sell')} onClick={() => { setSide('sell'); setAmount(''); setPct(undefined); }} role="tab" aria-selected={side === 'sell'}>
          Sell
        </button>
      </div>

      <div className="row between small muted" style={{ marginBottom: 6 }}>
        <span>{side === 'buy' ? 'Amount to spend' : 'Amount to sell'}</span>
        <span>
          {ad.ready ? (
            side === 'buy' ? (
              <>Balance: <b style={{ color: 'var(--ink)' }}>{fmtNum(balance, 4)} {info.quote}</b></>
            ) : (
              <>Holding: <b style={{ color: 'var(--ink)' }}>{fmtCompact(held)} ${coin.symbol}</b></>
            )
          ) : (
            'Not connected'
          )}
        </span>
      </div>

      <div className="amount-box">
        <input
          className={clsx('input', insufficient && 'bad')}
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value.replace(/[^0-9.]/g, ''));
            setPct(undefined);
          }}
          aria-label={side === 'buy' ? `Amount of ${info.quote} to spend` : `Amount of ${coin.symbol} to sell`}
        />
        <span className="suffix">
          {side === 'buy' ? info.quote : <><CoinAvatar coin={coin} size={22} round /> ${coin.symbol}</>}
        </span>
      </div>

      <div className="quick">
        {side === 'buy' ? (
          <>
            {buyQuick.map((v) => (
              <button key={v} onClick={() => { setAmount(String(v)); setPct(undefined); }}>{v}</button>
            ))}
            {/* leave a little for gas on live networks */}
            <button onClick={() => { setAmount(String(Math.floor(Math.max(0, balance - 0.01) * 1e6) / 1e6)); setPct(undefined); }}>Max</button>
          </>
        ) : (
          [25, 50, 75, 100].map((p) => (
            <button
              key={p}
              disabled={!held}
              onClick={() => {
                setPct(p);
                setAmount(String(Math.floor(((held * p) / 100) * 1e6) / 1e6));
              }}
              className={pct === p ? 'on' : ''}
            >
              {p}%
            </button>
          ))
        )}
      </div>

      {quote && !quote.ok && (amt > 0 || pct !== undefined) && <div className="err small" style={{ marginTop: 0 }}>{quote.error}</div>}
      {quote?.ok && (
        <div className="quote-lines" aria-live="polite">
          <div className="l">
            <span>You receive</span>
            <b>{side === 'buy' ? `${fmtCompact(quote.out)} $${coin.symbol}` : fmtQuote(quote.out, info.quote)}</b>
          </div>
          <div className="l">
            <span>Fee ({((quote.feeBps ?? 0) / 100).toFixed(2)}%)</span>
            <span>{fmtQuote(quote.fee, info.quote, 5)}</span>
          </div>
          <div className="l">
            <span>Price impact</span>
            <span className={(quote.impactPct ?? 0) > 5 ? 'down' : ''}>{fmtPct(quote.impactPct ?? 0, false)}</span>
          </div>
          {!!quote.refund && quote.refund > 0 && (
            <div className="l">
              <span>Refunded (curve full)</span>
              <span>{fmtQuote(quote.refund, info.quote)}</span>
            </div>
          )}
        </div>
      )}
      {quote?.graduates && <div className="notice green small" style={{ marginBottom: 10 }}>🎓 This buy fills the bonding curve and graduates ${coin.symbol} to a locked AMM pool.</div>}
      {quote?.warning && <div className="notice small" style={{ marginBottom: 10 }}>{quote.warning}</div>}
      {feeNote && !quote?.warning && <div className="notice small" style={{ marginBottom: 10 }}>{feeNote}</div>}
      {ad.note && <div className="xs muted" style={{ marginBottom: 10 }}>{ad.note}</div>}

      <div className="slip" style={{ marginBottom: 12 }}>
        <span>Max slippage</span>
        {[100, 300, 500, 1000].map((v) => (
          <button key={v} className={slip === v ? 'on' : ''} onClick={() => pickSlip(v)}>
            {v / 100}%
          </button>
        ))}
      </div>

      {!ad.ready ? (
        <button className="btn gold lg full" onClick={ad.connect}>
          {`Connect ${walletName} wallet to trade`}
        </button>
      ) : insufficient && side === 'buy' ? (
        <button className="btn lg full buy" disabled>Not enough {info.quote}</button>
      ) : (
        <button className={clsx('btn lg full', side === 'buy' ? 'buy' : 'sell')} disabled={!canSubmit} onClick={submit}>
          {busy ? (
            <>
              <span className="spinner" /> Confirm in your wallet…
            </>
          ) : quoting && (amt || pct !== undefined) ? (
            'Getting quote…'
          ) : (
            `${side === 'buy' ? 'Buy' : 'Sell'} $${coin.symbol}`
          )}
        </button>
      )}
      {ad.walletLimit != null && side === 'buy' && (
        <p className="xs muted" style={{ margin: '10px 0 0' }}>
          Early trading limit active: wallets can hold up to {fmtCompact(ad.walletLimit)} tokens for the first {info.antiSnipe?.limitSec ?? 120}s.
        </p>
      )}
    </div>
  );
}
