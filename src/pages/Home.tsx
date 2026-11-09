import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../lib/app';
import { BRAND, LogoMark } from '../components/Brand';
import { IBolt, ICoins, ILock, IRocket, IShield, ISwap, ITrophy, IWallet } from '../components/Icons';
import { Reveal } from '../components/Reveal';

export default function Home() {
  const { me, openConnect, evmCfg, evmName, chain: chainInfo } = useApp();
  const freeLaunch = chainInfo('hyp').launchFee === 0;

  useEffect(() => {
    document.title = `${BRAND} | The launchpad of the Elysium ecosystem`;
  }, []);

  const trust: [typeof IShield, string][] = [
    [IShield, 'Non-custodial: you sign everything'],
    ...(evmCfg ? ([[ILock, `Locked liquidity on ${evmName}`]] as [typeof IShield, string][]) : []),
    ...(freeLaunch ? ([[IBolt, 'Free to launch']] as [typeof IShield, string][]) : []),
  ];

  return (
    <div className="home">
      {/* ------------------------------------------------------------------ hero */}
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-grid">
          <div className="hero-copy">
            <span className="eyebrow cyan">Built for the Elysium ecosystem</span>
            <h1 id="hero-title">
              The launchpad for <em>the Elysium ecosystem</em>
            </h1>
            <p className="lead">
              Create a token in one form and launch it on {evmCfg ? `a locked-liquidity ${evmName} pool and ` : ''}a Solana bonding curve.
              Every transaction is signed in your own wallet.
            </p>
            <div className="hero-actions">
              <Link to="/create" className="btn gold lg"><IRocket size={18} /> Launch a token</Link>
            </div>
            <ul className="trust">
              {trust.map(([Ico, label]) => (
                <li key={label}><Ico size={15} /> {label}</li>
              ))}
            </ul>
          </div>

          <div className="hero-visual" aria-hidden="true">
            <div className="emblem">
              <span className="ring r1" />
              <span className="ring r2" />
              <LogoMark size={420} />
            </div>
          </div>
        </div>
      </section>

      <div className="page">
        {/* ------------------------------------------------------------------ how it works */}
        <Reveal as="section" className="section first" aria-labelledby="how">
          <div className="section-head">
            <div>
              <span className="kicker">How it works</span>
              <h2 id="how">From idea to live market in three steps</h2>
            </div>
          </div>
          <div className="steps">
            <div className="step">
              <div className="n">1</div>
              <h3>Create once</h3>
              <p>Name, ticker, image and links. Pick {evmName}, Solana or both. Trading fees pay you; on Solana you can share them with every holder instead.</p>
            </div>
            <div className="step">
              <div className="n">2</div>
              <h3>Confirm in your wallet</h3>
              <p>{freeLaunch ? 'Launching is free. ' : ''}Each chain is its own transaction, signed in your own wallet and paid in that chain's currency. This site never holds your funds.</p>
            </div>
            <div className="step">
              <div className="n">3</div>
              <h3>Trade everywhere</h3>
              <p>Your token goes live on each venue instantly. Trade the locked pool on {evmName}, climb the curve on Solana, and earn fees from both.</p>
            </div>
          </div>
        </Reveal>

        {/* ------------------------------------------------------------------ venues */}
        <Reveal as="section" className="section" aria-labelledby="chains">
          <div className="section-head">
            <div>
              <span className="kicker">Venues</span>
              <h2 id="chains">Where your token launches</h2>
            </div>
          </div>
          <div className="chain-cards">
            <div className="chain-card hyp">
              <span className="badge hyp">{evmName}</span>
              <h3>Straight onto Uniswap v4</h3>
              <p className="muted small">Every token gets its own Uniswap v4 pool, seeded with all 1B tokens. Nobody, including the creator, can pull the liquidity.</p>
              <ul>
                <li><ISwap size={14} /> Tradable on any Uniswap-compatible router</li>
                <li><IShield size={14} /> Anti-snipe fee for the first two minutes</li>
                <li><ILock size={14} /> Quoted in HYPE, liquidity locked</li>
              </ul>
            </div>
            <div className="chain-card sol">
              <span className="badge sol">Solana</span>
              <h3>Solana bonding curve</h3>
              <p className="muted small">Price rises along a curve as people buy. Fill it and the token graduates into a locked AMM pool.</p>
              <ul>
                <li><ITrophy size={14} /> Starts at ~28 SOL market cap, graduates at 85 SOL raised</li>
                <li><ICoins size={14} /> Fees: 0.95% protocol + 0.30% creator</li>
                <li><IWallet size={14} /> Quoted in SOL</li>
              </ul>
            </div>
          </div>
        </Reveal>

        {/* ------------------------------------------------------------------ call to action */}
        <Reveal as="section" className="cta-band">
          <LogoMark size={96} />
          <h2>Ready to launch?</h2>
          <p>It takes about a minute, and a first buy is optional. Your token goes live the moment you confirm.</p>
          {me ? (
            <Link to="/create" className="btn gold lg"><IRocket size={18} /> Launch a token</Link>
          ) : (
            <button className="btn gold lg" onClick={() => openConnect()}>Connect wallet to start</button>
          )}
        </Reveal>
      </div>
    </div>
  );
}
