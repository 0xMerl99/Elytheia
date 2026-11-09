import { Link, useLocation } from 'react-router-dom';
import { useApp } from '../lib/app';
import { BRAND, Logo } from './Brand';
import { IBook, IHome, IRocket, ISearch, IUser, IX, IXLogo } from './Icons';

/** Phones and tablets: primary navigation as a thumb-reach tab bar, with Launch raised in the middle. */
export function TabBar() {
  const loc = useLocation();
  // the launch wizard has its own sticky action bar in this spot
  if (loc.pathname === '/create') return null;
  const items: { to?: string; label: string; Ico: typeof IHome; on: boolean; launch?: boolean }[] = [
    { to: '/home', label: 'Home', Ico: IHome, on: loc.pathname === '/home' },
    { label: 'Search', Ico: ISearch, on: false },
    { to: '/create', label: 'Launch', Ico: IRocket, on: false, launch: true },
    { to: '/profile', label: 'Portfolio', Ico: IUser, on: loc.pathname.startsWith('/profile') || loc.pathname.startsWith('/u/') },
    { to: '/docs', label: 'Docs', Ico: IBook, on: loc.pathname.startsWith('/docs') },
  ];
  return (
    <nav className="tabbar" aria-label="Primary">
      {items.map(({ to, label, Ico, on, launch }) => {
        const inner = (
          <>
            <span className="ico"><Ico size={launch ? 24 : 22} /></span>
            <span className="lbl">{label}</span>
          </>
        );
        return to ? (
          <Link key={label} to={to} className={`${on ? 'on' : ''}${launch ? ' launch' : ''}`} aria-current={on ? 'page' : undefined}>
            {inner}
          </Link>
        ) : (
          <button key={label} type="button" onClick={() => window.dispatchEvent(new Event('elyonpad:search'))}>
            {inner}
          </button>
        );
      })}
    </nav>
  );
}

export function Footer() {
  const { evmCfg, evmName, config } = useApp();
  const xUrl = config?.project.xUrl;
  return (
    <footer className="footer">
      <div className="footer-in">
        <div className="footer-brand">
          <Logo />
          <p>The launchpad of the Elysium ecosystem. Create a token once, launch it on {evmCfg ? `${evmName} and ` : ''}Solana, and trade straight from your own wallet.</p>
        </div>
        <div>
          <h4>Product</h4>
          <div className="footer-links">
            <Link to="/create">Launch a token</Link>
            <Link to="/profile">Portfolio</Link>
          </div>
        </div>
        <div>
          <h4>Resources</h4>
          <div className="footer-links">
            <Link to="/docs">Documentation</Link>
            <Link to="/docs#fees">Fees</Link>
            <Link to="/docs#risks">Risks</Link>
            <Link to="/docs#faq">FAQ</Link>
          </div>
        </div>
        <div>
          <h4>Community</h4>
          <div className="footer-links">
            {xUrl && (
              <a href={xUrl} target="_blank" rel="noopener noreferrer" aria-label={`${BRAND} on X`}>
                <IXLogo size={14} /> X
              </a>
            )}
          </div>
        </div>
      </div>
      <div className="footer-legal">
        <b>{BRAND}</b> · built for the Elysium ecosystem. You are connected to live networks ({evmCfg ? `${evmCfg.name} and ` : ''}Solana mainnet via pump.fun):
        transactions are real and irreversible. {evmCfg && <>The {evmName} contracts are <b>unaudited</b>. </>}Tokens are permissionless and anyone can launch
        anything. Nothing here is financial advice.
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
          <button className="icon-btn" onClick={() => dismissToast(t.id)} aria-label="Dismiss" style={{ padding: 0, minWidth: 24, minHeight: 24 }}>
            <IX size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
