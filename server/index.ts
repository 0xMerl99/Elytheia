import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { DATA_DIR, DIST_DIR, EVM, IS_PROD, PORT, PUBLIC_URL, SOL, UPLOAD_DIR } from './config.js';
import { allowedHosts } from './chain/metadata.js';
import { evmEnabled, startEvmIndexer } from './chain/evm.js';
import { startSolanaIndexer } from './chain/solana.js';
import './db.js';
import { api } from './routes.js';
import { startPriceLoop } from './prices.js';
import { ApiError } from './util.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

/** "https://host:port" of a URL, for the CSP (the browser talks to exactly these RPC endpoints, nothing else). */
const origin = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    return '';
  }
};

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
        // remote coin images are only ever allow-listed IPFS gateways (see chain/metadata.ts)
        'img-src': ["'self'", 'data:', 'blob:', ...[...allowedHosts(PUBLIC_URL)].flatMap((h) => [`https://${h}`, `https://*.${h}`])],
        // Solana goes through this server's proxy ('self'); the browser talks directly only to the public EVM RPC
        'connect-src': ["'self'", ...new Set([origin(EVM.browserRpcUrl)].filter(Boolean))],
        'frame-ancestors': ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(express.json({ limit: '3mb' }));

app.use('/api', api);

// uploaded coin images: served inertly (never executed as HTML)
app.use(
  '/uploads',
  express.static(UPLOAD_DIR, {
    maxAge: '7d',
    immutable: true,
    index: false,
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'");
    },
  }),
);

// coin metadata JSON: public and CORS-open so other sites (pump.fun, explorers) can read it
app.use(
  '/metadata',
  express.static(path.join(DATA_DIR, 'metadata'), {
    maxAge: '1h',
    index: false,
    setHeaders: (res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    },
  }),
);

if (fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
  app.use(express.static(DIST_DIR, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api\/|\/uploads\/|\/metadata\/).*/, (_req, res) => {
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
} else if (IS_PROD) {
  console.warn('[web] dist/ not found. Run `npm run build` first.');
}

app.use('/api', (_req, _res, next) => next(new ApiError(404, 'Not found')));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ error: err.issues[0]?.message ?? 'Invalid input' });
  }
  if ((err as { type?: string })?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request too large' });
  }
  if (err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Malformed request' });
  }
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong' });
});

// the indexers record USD figures, so they start once the first price lookup has finished (it never takes over ~6s)
void startPriceLoop().then(() => {
  startEvmIndexer(); // no-ops (with a note) until HYP_LAUNCHPAD is set
  startSolanaIndexer();
});

app.listen(PORT, () => {
  console.log(`\n  ELYONPAD  →  http://localhost:${PORT}${IS_PROD ? '' : '   (UI via Vite on http://localhost:5173)'}`);
  console.log(`  Solana    ${SOL.cluster} (pump.fun)`);
  console.log(`  EVM       ${evmEnabled() ? `${EVM.name} · launchpad ${EVM.launchpad}` : `not deployed yet (set HYP_LAUNCHPAD after deploying; chain ${EVM.chainId})`}\n`);
  if (IS_PROD && !/^https:\/\//i.test(PUBLIC_URL)) {
    // coin metadata links are built from this address and written into the blockchain for good
    console.warn(`  ! PUBLIC_URL is "${PUBLIC_URL}", not an https address. Set it to the final public address BEFORE anyone launches a coin:\n    metadata links on-chain are permanent, so a coin launched now would point at a dead address.\n`);
  }
});
