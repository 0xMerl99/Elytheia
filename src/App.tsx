import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppProvider } from './lib/app';
import { ConnectModal, WalletModal, Header } from './components/Header';
import { Footer, TabBar, Toasts } from './components/Shell';
import Intro from './components/Intro';
import Home from './pages/Home';
import NotFound from './pages/NotFound';

// heavier pages (chart library, long docs) load on demand
const CoinPage = lazy(() => import('./pages/Coin'));
const Create = lazy(() => import('./pages/Create'));
const Profile = lazy(() => import('./pages/Profile'));
const Docs = lazy(() => import('./pages/Docs'));

function ScrollToTop() {
  const { pathname, hash } = useLocation();
  // hash targets handle their own scrolling; everything else starts at the top
  useEffect(() => {
    if (!hash) window.scrollTo({ top: 0 });
  }, [pathname, hash]);
  return null;
}

function Fallback() {
  return (
    <div className="page">
      <div className="skeleton" style={{ height: 240 }} />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Header />
      <div className="app-body">
        <main id="main">
          <ScrollToTop />
          <Suspense fallback={<Fallback />}>
            <Routes>
              <Route path="/" element={<Navigate to="/home" replace />} />
              <Route path="/home" element={<Home />} />
              <Route path="/create" element={<Create />} />
              <Route path="/coin/:id" element={<CoinPage />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/u/:address" element={<Profile />} />
              <Route path="/docs" element={<Docs />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </main>
        <Footer />
      </div>
      <TabBar />
      <ConnectModal />
      <WalletModal />
      <Toasts />
      <Intro />
    </AppProvider>
  );
}
