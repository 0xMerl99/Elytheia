import { useEffect, useState } from 'react';
import { useApp } from '../lib/app';
import { clsx, copyText, fmtPct, fmtUsd, shortAddr } from '../lib/format';
import type { ProjectToken } from '../lib/types';
import { ICheck, ICopy, IExt } from './Icons';

/**
 * The project's own token, shown in the Launches grid like any other coin but marked "Official". The site cannot trade it
 * (pump.fun prices it in HYPE, not SOL), so the card carries live numbers and sends people to pump.fun to trade.
 */
export function ProjectTokenCard({ token }: { token: ProjectToken }) {
  const { toast } = useApp();
  const sources = [token.image, ...token.imageFallbacks].filter((s): s is string => !!s);
  const [srcIdx, setSrcIdx] = useState(0); // next gateway when one fails; past the end = show the initials
  const [copied, setCopied] = useState(false);
  const up = (token.change24 ?? 0) >= 0;
  const symbol = token.symbol ?? 'TOKEN';

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    const ok = await copyText(token.mint);
    setCopied(ok);
    toast(ok ? 'Contract address copied' : 'Copy failed', ok ? 'ok' : 'err');
  };

  return (
    <div className="coin-card official">
      <a className="official-link" href={token.pumpUrl} target="_blank" rel="noopener noreferrer" aria-label={`${token.name ?? symbol} on pump.fun`}>
        <div className="top">
          <span className="avatar official-avatar" style={{ width: 52, height: 52 }}>
            {srcIdx < sources.length ? (
              <img src={sources[srcIdx]} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setSrcIdx((i) => i + 1)} />
            ) : (
              <span aria-hidden="true" style={{ fontSize: 20 }}>{symbol.slice(0, 2).toUpperCase()}</span>
            )}
          </span>
          <div className="grow">
            <div className="row between">
              <div className="trunc">
                <span className="name">{token.name ?? symbol}</span> <span className="sym">${symbol}</span>
              </div>
            </div>
            <div className="row gap-sm wrap" style={{ marginTop: 4 }}>
              <span className="badge official">Official</span>
              <span className="badge sol">Solana</span>
              <span className="badge neutral">pump.fun</span>
            </div>
          </div>
        </div>
        <p className="desc" style={{ margin: 0 }}>
          {token.description || 'The official token of Elytheia.'}
        </p>
        <div className="meta">
          <div>
            <small>Mcap</small>
            <b>{fmtUsd(token.mcapUsd)}</b>
          </div>
          <div>
            <small>24h</small>
            <b className={token.change24 === null ? undefined : up ? 'up' : 'down'}>{token.change24 === null ? '–' : fmtPct(token.change24)}</b>
          </div>
          <div>
            <small>Vol 24h</small>
            <b>{fmtUsd(token.volume24Usd)}</b>
          </div>
        </div>
      </a>

      <div className="official-actions">
        <button type="button" className={clsx('ca-chip', copied && 'ok')} onClick={copy} aria-label="Copy contract address" title={token.mint}>
          <span className="ca-chip-label">CA</span>
          <span className="mono">{shortAddr(token.mint, 4, 4)}</span>
          {copied ? <ICheck size={13} /> : <ICopy size={13} />}
        </button>
        <a className="btn gold sm" href={token.pumpUrl} target="_blank" rel="noopener noreferrer">
          Trade on pump.fun <IExt size={13} />
        </a>
      </div>
    </div>
  );
}
