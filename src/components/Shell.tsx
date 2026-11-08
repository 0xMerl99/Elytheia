import { Link, NavLink, useLocation } from 'react-router-dom';
import { useApp } from '../lib/app';
import { BRAND } from './Brand';
import { IBook, IGrid, IHome, IRocket, ITrophy, IUser, IX, IXLogo } from './Icons';

export function Rail() {
  const loc = useLocation();
  const items: [string, string, typeof IHome, boolean][] = [
    ['/home', 'Home', IHome, loc.pathname === '/home' && !loc.search],
    ['/home?sort=hot#coins', 'Launches', IGrid, loc.pathname === '/home' && loc.search.includes('sort=hot')],
    ['/create', 'Launch a coin', IRocket, loc.pathname === '/create'],
    ['/home?sort=mcap#coins', 'Top coins', ITrophy, loc.pathname === '/home' && loc.search.includes('sort=mcap')],
    ['/profile', 'Portfolio', IUser, loc.pathname.startsWith('/profile') || loc.pathname.startsWith('/u/')],
    ['/docs', 'Docs', IBook, loc.pathname.startsWith('/docs')],
  ];
  return (
    <>
      <aside className="rail" aria-label="Quick navigation">
        {items.map(([to, label, Ico, on]) => (
          <Link key={label} to={to} className={on ? 'on' : ''} data-label={label} aria-label={label}>
            <Ico />
          </Link>
        ))}
      </aside>
      <nav className="bottom-nav" aria-label="Primary">
        {items
          .filter((i) => i[1] !== 'Top coins')
          .map(([to, label, Ico, on]) => (
            <Link key={label} to={to} className={on ? 'on' : ''}>
              <Ico />
              <span>{label === 'Launch a coin' ? 'Launch' : label}</span>
            </Link>
          ))}
      </nav>
    </>
  );
}

export function Footer() {
  const { evmCfg, evmName, config } = useApp();
  return (
    <footer className="footer">
      <div className="links">
        <NavLink to="/docs">Docs</NavLink>
        <NavLink to="/docs#fees">Fees</NavLink>
        <NavLink to="/docs#risks">Risks</NavLink>
        <NavLink to="/docs#faq">FAQ</NavLink>
        <a href={config?.project.xUrl ?? 'https://x.com/useelytheia'} target="_blank" rel="noopener noreferrer" aria-label={`${BRAND} on X`}>
          <IXLogo size={13} style={{ verticalAlign: '-1px', marginRight: 5 }} />X
        </a>
      </div>
      <div>
        {BRAND} · one launch, every chain. Connected to live networks ({evmCfg ? `${evmCfg.name} and ` : ''}Solana mainnet via pump.fun): transactions are
        real and irreversible. {evmCfg && <>The {evmName} contracts are <b>unaudited</b>. </>}Coins are permissionless and anyone can launch anything. Not financial advice.
      </div>
    </footer>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="grow">{t.text}</span>
          <button className="icon-btn" onClick={() => dismissToast(t.id)} aria-label="Dismiss" style={{ color: '#fff', padding: 0 }}>
            <IX size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
