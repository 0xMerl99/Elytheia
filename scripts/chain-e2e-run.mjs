// One-command on-chain test: a local FORK of the real Elysium chain (anvil) -> deploy the Uniswap v4 stack with the real deploy
// script -> this site's server in real mode -> scripts/chain-e2e.ts -> teardown. Nothing touches mainnet.
//   npm run chain:test
// Requires Foundry (anvil) on PATH and a compiled v4 stack: (cd contracts && FOUNDRY_PROFILE=v4 forge build)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const FORK_URL = process.env.ELYSIUM_FORK_RPC || 'https://elys.fun/rpc'; // read-only use: the fork only reads state from it
const ANVIL_PORT = 8545;
const API_PORT = 8790;
const KEY0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // anvil's public dev key
const DATA = path.resolve('data-real');
const RECORD = path.join(DATA, 'deploy-record.json');
const children = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(url, init, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, init);
      if (r.ok) return;
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
      // on Windows a plain kill leaves grandchildren (npx/tsx) alive, so kill the whole tree
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
      else c.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}
process.on('SIGINT', () => { cleanup(); process.exit(130); });

try {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  console.log(`> forking Elysium (anvil, state read from ${FORK_URL})`);
  children.push(spawn('anvil', ['--fork-url', FORK_URL, '--chain-id', '99901', '--port', String(ANVIL_PORT), '--silent'], { stdio: 'ignore', shell: process.platform === 'win32' }));
  await waitFor(`http://127.0.0.1:${ANVIL_PORT}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }, 'anvil');

  console.log('> deploying the Uniswap v4 launch stack on the fork');
  const dep = spawnSync('node', ['scripts/deploy-v4.mjs', '--rpc', `http://127.0.0.1:${ANVIL_PORT}`, '--owner', 'self', '--yes', '--record', RECORD], {
    encoding: 'utf8', shell: process.platform === 'win32', env: { ...process.env, ALLOW_MAINNET: '1', DEPLOYER_KEY: KEY0 },
  });
  if (dep.status !== 0) throw new Error('deploy failed:\n' + dep.stdout + dep.stderr);
  const record = JSON.parse(fs.readFileSync(RECORD, 'utf8'));
  console.log(`  launchpad ${record.launchpad}, hook ${record.hook}, block ${record.deployBlock}`);

  console.log('> starting the server in real mode');
  const server = spawn('npx', ['tsx', 'server/index.ts'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: {
      ...process.env, PORT: String(API_PORT), DATA_DIR: './data-real', HYP_CHAIN_ID: '99901', HYP_CHAIN_NAME: 'Elysium (fork)',
      HYP_RPC_URL: `http://127.0.0.1:${ANVIL_PORT}`, HYP_BROWSER_RPC_URL: `http://127.0.0.1:${ANVIL_PORT}`, HYP_LAUNCHPAD: record.launchpad,
      HYP_START_BLOCK: String(record.deployBlock), HYP_POLL_MS: '1000', PUBLIC_URL: `http://localhost:${API_PORT}`,
    },
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  children.push(server);
  await waitFor(`http://localhost:${API_PORT}/api/health`, undefined, 'the server');

  console.log('> running the on-chain end-to-end test\n');
  const test = spawnSync('npx', ['tsx', 'scripts/chain-e2e.ts'], {
    stdio: 'inherit', shell: process.platform === 'win32',
    env: { ...process.env, API: `http://localhost:${API_PORT}`, RPC: `http://127.0.0.1:${ANVIL_PORT}`, PAD: record.launchpad },
  });
  cleanup();
  process.exit(test.status ?? 1);
} catch (e) {
  console.error(e.message || e);
  cleanup();
  process.exit(1);
}
