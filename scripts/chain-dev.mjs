// Try LIVE mode locally with zero risk: a throwaway local FORK of Elysium (anvil) with the Uniswap v4 launchpad deployed on it, and
// this site running in real mode against it. Connect MetaMask to http://127.0.0.1:8545 (chain id 99901) and import one of anvil's
// public dev keys (printed below). Those keys are published in anvil's docs and hold fake ETH on a local chain only.
//   npm run build && npm run chain:dev
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ANVIL_PORT = 8545;
const API_PORT = Number(process.env.PORT || 8790);
const KEY0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
let PAD = '';
const FORK_URL = process.env.ELYSIUM_FORK_RPC || 'https://elys.fun/rpc';
const DATA = path.resolve('data-real');
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, init, label) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url, init)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}`);
}
function cleanup() {
  for (const c of children) {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
      else c.kill('SIGTERM');
    } catch {
      /* gone */
    }
  }
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

try {
  if (!fs.existsSync('dist/index.html')) console.warn('! dist/ is missing: run `npm run build` first so the server can serve the UI.');
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  console.log('> local FORK of Elysium (anvil) on :' + ANVIL_PORT + ' (state is read from ' + FORK_URL + '; nothing is ever sent to it)');
  children.push(spawn('anvil', ['--fork-url', FORK_URL, '--chain-id', '99901', '--port', String(ANVIL_PORT), '--silent'], { stdio: 'ignore', shell: process.platform === 'win32' }));
  await waitFor(`http://127.0.0.1:${ANVIL_PORT}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }, 'anvil');

  console.log('> deploying the Uniswap v4 launch stack on the fork');
  const dep = spawnSync('node', ['scripts/deploy-v4.mjs', '--rpc', `http://127.0.0.1:${ANVIL_PORT}`, '--owner', 'self', '--yes', '--record', path.join(DATA, 'deploy-record.json')], {
    encoding: 'utf8', shell: process.platform === 'win32', env: { ...process.env, ALLOW_MAINNET: '1', DEPLOYER_KEY: KEY0 },
  });
  if (dep.status !== 0) throw new Error('deploy failed: ' + dep.stdout + dep.stderr);
  const record = JSON.parse(fs.readFileSync(path.join(DATA, 'deploy-record.json'), 'utf8'));
  PAD = record.launchpad;

  console.log('> site in LIVE mode on :' + API_PORT);
  const server = spawn('npx', ['tsx', 'server/index.ts'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env, PORT: String(API_PORT), DATA_DIR: './data-real', HYP_CHAIN_ID: '99901', HYP_CHAIN_NAME: 'Elysium (local fork)',
      HYP_RPC_URL: `http://127.0.0.1:${ANVIL_PORT}`, HYP_BROWSER_RPC_URL: `http://127.0.0.1:${ANVIL_PORT}`, HYP_LAUNCHPAD: PAD, HYP_START_BLOCK: String(record.deployBlock), HYP_POLL_MS: '1500', PUBLIC_URL: `http://localhost:${API_PORT}`,
    },
  });
  children.push(server);
  await waitFor(`http://localhost:${API_PORT}/api/health`, undefined, 'the server');

  console.log(`
  ✔ Ready

    Open            http://localhost:${API_PORT}
    Chain           Elysium, local fork · RPC http://127.0.0.1:${ANVIL_PORT} · chain id 99901 · currency HYPE (fake funds)
    Launchpad       ${PAD}

    Anvil dev accounts (PUBLIC keys, fake funds, local chain only):
      #1 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
         key 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
      #2 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
         key 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a

    Solana launches use pump.fun's REAL mainnet program, so they spend real SOL: use a wallet you are comfortable with,
    or untick Solana on the launch page.

    Ctrl+C stops everything.
`);
  await new Promise(() => {}); // run until interrupted
} catch (e) {
  console.error(e.message || e);
  cleanup();
  process.exit(1);
}
