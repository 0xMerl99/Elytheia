import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useApp } from '../lib/app';
import { clsx } from '../lib/format';
import { BRAND } from '../components/Brand';

const SECTIONS: [string, string][] = [
  ['overview', 'Overview'],
  ['start', 'Getting started'],
  ['launching', 'Launching a token'],
  ['chains', 'Chains & pricing'],
  ['fees', 'Fees'],
  ['rewards', 'Creator & holder rewards'],
  ['protection', 'Launch protection'],
  ['payments', 'Paying for a launch'],
  ['live', 'Live networks'],
  ['roadmap', 'Roadmap'],
  ['risks', 'Risks'],
  ['faq', 'FAQ'],
];

export default function Docs() {
  const { chain, config, evmCfg, evmName } = useApp();
  const loc = useLocation();
  const [active, setActive] = useState('overview');
  const sol = chain('sol');
  const hyp = chain('hyp');
  const a = hyp.antiSnipe;
  const net = evmName;

  useEffect(() => {
    document.title = `Docs | ${BRAND}`;
  }, []);

  useEffect(() => {
    if (loc.hash) {
      const el = document.getElementById(loc.hash.slice(1));
      if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30);
    } else window.scrollTo({ top: 0 });
  }, [loc.hash]);

  useEffect(() => {
    const els = SECTIONS.map(([id]) => document.getElementById(id)).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((x, y) => x.boundingClientRect.top - y.boundingClientRect.top)[0];
        if (vis) setActive(vis.target.id);
      },
      { rootMargin: '-80px 0px -65% 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <div className="page docs-page">
      <div className="docs-layout">
        <nav className="docs-nav" aria-label="Documentation">
          {SECTIONS.map(([id, label]) => (
            <Link key={id} to={`/docs#${id}`} className={clsx(active === id && 'on')}>{label}</Link>
          ))}
        </nav>

        <article className="prose">
          <h1>{BRAND} docs</h1>
          <p className="muted">How launches, trading, fees and rewards work.</p>

          <h2 id="overview">Overview</h2>
          <p>
            {BRAND} is the launchpad of the Elysium ecosystem: a multichain token launchpad. You create a token once from a single form and launch it on every chain you select. Every
            transaction is signed in <b>your own wallet</b>; this site never holds your keys or your funds. It reads public chain data to show
            feeds, charts and portfolios.
          </p>
          <p>Two venues:</p>
          <ul>
            <li><b>Solana</b>: tokens are real pump.fun tokens on a bonding curve, created and traded through pump.fun's own on-chain program.</li>
            <li><b>{net}</b>: tokens launch straight onto a <b>Uniswap v4</b> pool with locked liquidity, created by this project's launchpad contract{evmCfg ? '' : ' (not deployed on this site yet)'}.</li>
          </ul>

          <h2 id="start">Getting started</h2>
          <ol>
            <li><b>Connect a wallet.</b> Phantom, Solflare or Backpack for Solana; MetaMask, Rabby or any browser wallet for {net}.</li>
            <li><b>Sign in.</b> You sign a free message that proves you own the address. It can't move funds.</li>
            <li><b>Trade or launch.</b> Open any token to buy and sell, or <Link to="/create">launch a token</Link>. Have a pump.fun token in mind? Paste its address into the search bar to add it.</li>
          </ol>

          <h2 id="launching">Launching a token</h2>
          <p>On the <Link to="/create">launch page</Link> you set:</p>
          <ul>
            <li><b>Identity:</b> name (up to 32 characters), ticker (2–10 letters/numbers), image and description. Website, X and Telegram are optional.</li>
            <li><b>Chains:</b> one or both. Each chain gets its own token and market, linked by the launch.</li>
            <li><b>First buy:</b> optional. It's part of the same transaction as the launch, so nobody can buy before you.{' '}
              On {net} it is capped at {config?.limits.maxCreatorBuyPct ?? 20}% of supply.</li>
            <li><b>Rewards mode:</b> trading fees to you, or shared with every holder.</li>
          </ul>
          <p>
            Your token's name, ticker and metadata link are written on-chain and can <b>never be changed</b>. Launching itself is free: you only pay
            network costs and anything you choose to buy.
          </p>

          <h2 id="chains">Chains &amp; pricing</h2>
          <table className="stack">
            <thead><tr><th /><th>Solana (pump.fun)</th><th>{net}</th></tr></thead>
            <tbody>
              <tr><td data-label="" className="rowhead">Venue</td><td data-label="Solana (pump.fun)">{sol.venue}</td><td data-label={net}>{hyp.venue}</td></tr>
              <tr><td data-label="" className="rowhead">Quote asset</td><td data-label="Solana (pump.fun)">SOL</td><td data-label={net}>HYPE</td></tr>
              <tr><td data-label="" className="rowhead">Supply</td><td data-label="Solana (pump.fun)">1B</td><td data-label={net}>1B</td></tr>
              <tr><td data-label="" className="rowhead">Start market cap</td><td data-label="Solana (pump.fun)">~28 SOL</td><td data-label={net}>{(hyp.startMcapTiers ?? []).join(' / ')} HYPE{(hyp.startMcapTiers?.length ?? 0) > 1 ? ' (your choice)' : ''}</td></tr>
              <tr><td data-label="" className="rowhead">Graduation</td><td data-label="Solana (pump.fun)">At {sol.graduationQuote} SOL raised</td><td data-label={net}>None, always a full pool</td></tr>
              <tr><td data-label="" className="rowhead">Launch fee</td><td data-label="Solana (pump.fun)">Free (rent + network fees only)</td><td data-label={net}>{hyp.launchFee ? `${hyp.launchFee} HYPE` : 'Free (network gas only)'}</td></tr>
            </tbody>
          </table>
          <h3>Solana bonding curve</h3>
          <p>
            Price follows a constant-product curve with virtual reserves (30 SOL against 1.073B tokens). The first 793.1M tokens are sold along
            the curve. When {sol.graduationQuote} SOL has been raised the curve closes and liquidity moves to an AMM pool. This is pump.fun's program,
            so its rules apply, not ours.
          </p>
          <h3>{net} pool</h3>
          <p>
            Every token launches straight onto a Uniswap v4 pool paired with HYPE. All 1B tokens are placed in one position that starts at
            the launch price (about {(hyp.startMcapTiers ?? [])[0]?.toFixed(1) ?? '–'} HYPE market cap) and reaches down to the lowest usable price, so buys move the
            price up smoothly and sells move it back. The launchpad owns that position and has no function that can remove it, so liquidity
            is locked from the first block. It is a normal Uniswap pool: any Uniswap-compatible router or aggregator can trade it too.
          </p>

          <h2 id="fees">Fees</h2>
          <table className="stack">
            <thead><tr><th>Fee</th><th>Amount</th><th>Goes to</th></tr></thead>
            <tbody>
              <tr><td data-label="" className="rowhead">Solana trade fee</td><td data-label="Amount">0.95% protocol + 0.30% creator</td><td data-label="Goes to">pump.fun and the token's creator</td></tr>
              <tr><td data-label="" className="rowhead">{net} trade fee</td><td data-label="Amount">{(hyp.baseFeeBps / 100).toFixed(1)}% of each buy or sell</td><td data-label="Goes to">½ protocol, ½ creator (paid to the pool's liquidity position, then split)</td></tr>
              <tr><td data-label="" className="rowhead">Launch fee</td><td data-label="Amount">{hyp.launchFee ? `${hyp.launchFee} HYPE on ${net} (none on Solana)` : 'Free: launching a token costs nothing beyond network costs'}</td><td data-label="Goes to">{hyp.launchFee ? 'Protocol' : '–'}</td></tr>
              <tr><td data-label="" className="rowhead">Anti-snipe surcharge</td><td data-label="Amount">Up to {a ? a.startBps / 100 : 20}% extra, {net} only, first {a?.durationSec ?? 120}s</td><td data-label="Goes to">Shared like any other fee (½ protocol, ½ creator)</td></tr>
            </tbody>
          </table>

          <h2 id="rewards">Creator rewards</h2>
          <ul>
            <li><b>Creator fees</b> accumulate for the launching wallet. On {net} the creator's half of every pool fee is paid out when you press Claim (it collects the pool's latest fees first); on Solana they build up in your pump.fun creator vault (shared across all your pump.fun tokens) and can be collected from the token page.</li>
            <li><b>Holder rewards</b> (Solana only) share the creator-side fee with everyone holding the token, inside pump.fun's own program. They are not available on {net}: a Uniswap v4 pool pays its fees to the liquidity position, not to holders. The choice is permanent for that token.</li>
          </ul>

          <h2 id="protection">Launch protection</h2>
          <ul>
            <li><b>AntiVamp</b> ({net}). A launch is rejected if a token with the same name <i>and</i> ticker already exists, so copycats can't hijack a community.</li>
            <li><b>Dynamic anti-snipe fee</b> ({net}). Trades in the first {a?.durationSec ?? 120} seconds carry an extra fee that starts at {a ? a.startBps / 100 : 20}% and decays linearly to zero.</li>
            <li><b>Locked liquidity.</b> On {net} the launchpad owns the only liquidity position and has no way to remove it; the only privileged action is withdrawing accrued protocol fees.</li>
            <li><b>Image safety.</b> Uploads are verified by file signature, SVG is refused, and files are served as inert images.</li>
          </ul>

          <h2 id="payments">Paying for a launch</h2>
          <p>
            Each launch is one wallet-signed transaction per chain, paid in that chain's own currency: HYPE on {net} (network gas plus your
            optional first buy) and SOL on Solana (account rent and network fees plus your optional first buy; pump.fun charges no separate launch fee).
            There is no cross-chain conversion step, because moving value between chains is something only you should ever authorise.
          </p>

          <h2 id="live">Live networks</h2>
          <div className="notice red">
            <b>This site is connected to live chains.</b> Transactions are signed in your own wallet and cannot be undone. The {net} contracts are
            <b> unaudited</b>. Only use funds you can afford to lose.
          </div>
          <ul style={{ marginTop: 12 }}>
            <li><b>{net}</b> (chain {config?.evm.chainId ?? '…'}): tokens are created and traded on this project's Launchpad contract. The only privileged action is withdrawing accrued protocol fees; nobody can touch pool liquidity.</li>
            <li><b>Solana</b>: tokens are real pump.fun tokens, created and traded through pump.fun's own on-chain program. Fees and graduation are pump.fun's rules, not ours.</li>
            <li><b>No custody.</b> This site never holds keys or funds. It indexes public chain data to show feeds, charts and portfolios.</li>
            <li><b>Permanent metadata.</b> A token's name, ticker and metadata link are written on-chain and can never be changed.</li>
          </ul>
          <p>
            Prices shown in USD come from a public price feed (CoinGecko){config && config.prices.SOL > 0 ? `: SOL $${config.prices.SOL.toFixed(2)} · HYPE $${config.prices.HYPE.toFixed(2)}` : ''}.{' '}
            {config && !config.prices.SOL && 'The feed has not been reachable yet, so USD values show as a dash until it is. '}
            {config && config.evm.chainId !== 999 && config.evm.chainId !== 998 && <>HYPE on {net} is valued at Hyperliquid&apos;s HYPE price, which only holds while it can be bridged back 1:1. </>}
            Token amounts on-chain are always exact; USD is only an estimate.
          </p>

          <h2 id="roadmap">Roadmap</h2>
          <div className="roadmap">
            <div className="ph"><h3>Live now</h3><ul><li>Multichain launch flow</li><li>pump.fun integration on Solana</li><li>Launches straight onto Uniswap v4 on {net}</li><li>Creator rewards</li></ul></div>
            <div className="ph"><h3>Next</h3><ul><li>Independent contract audit</li><li>{net} mainnet launch</li><li>Pool trading after Solana graduation</li></ul></div>
            <div className="ph"><h3>Later</h3><ul><li>Scheduled launches</li><li>Custom fee splits</li><li>Deployment monitoring</li></ul></div>
            <div className="ph"><h3>Ecosystem</h3><ul><li>More chains</li><li>Open API &amp; analytics</li><li>Better discovery</li></ul></div>
          </div>

          <h2 id="risks">Risks</h2>
          <p>
            Launching and trading tokens is risky: prices are volatile, most tokens go to zero, and permissionless tokens can be misleading. Anyone
            can launch anything. Do your own research. The {net} contracts are unaudited until stated otherwise, and pump.fun is a third-party
            program that can change. Nothing on this site is financial advice.
          </p>

          <h2 id="faq">FAQ</h2>
          <details className="faq"><summary>Can the creator pull the liquidity?</summary><p>On {net}, no: liquidity is locked at launch and there is no withdrawal path. On Solana, pump.fun's program governs the curve and its post-graduation pool.</p></details>
          <details className="faq"><summary>How do I add a pump.fun token that isn't listed?</summary><p>Paste its address into the search bar and choose “Import this pump.fun token”. Its creation is found and verified on-chain.</p></details>
          <details className="faq"><summary>What happens when a Solana token graduates?</summary><p>pump.fun closes the curve and moves liquidity into an AMM pool. This site shows it as graduated; trading continues on that pool, not on the curve.</p></details>
          <details className="faq"><summary>Can I change the rewards mode later?</summary><p>No. It's set at launch so holders can rely on it.</p></details>
          <details className="faq"><summary>Why was my buy in the first two minutes so expensive?</summary><p>{net} tokens carry a launch surcharge that starts at 20% on top of the 1% fee and decays to zero over two minutes. Wait it out, or accept the price: the quote you see already includes it.</p></details>
          <details className="faq"><summary>Is my wallet at risk?</summary><p>Signing in only asks for a message signature. Trades are separate transactions you approve one by one, and the site never asks for your seed phrase. Never share a secret key with any site.</p></details>
        </article>
      </div>
    </div>
  );
}
