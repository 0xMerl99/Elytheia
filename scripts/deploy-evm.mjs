// Deploys the Launchpad to the EVM chain and wires the site to it.
//
//   node scripts/deploy-evm.mjs --rpc https://elys.fun/rpc --owner 0xYourWallet --dry-run     (simulate only: no key, no funds)
//   ALLOW_MAINNET=1 node scripts/deploy-evm.mjs --rpc https://elys.fun/rpc --owner 0xYourWallet --write-env
//
// Why not `forge script`: on Arbitrum-based chains (Elysium) forge's local simulation leaves out the layer-1 data part of the
// gas cost, so its gas limit comes out too low, and block.number inside a script is the L1 number, so the "deploy block" it
// prints is wrong for the indexer. This script uses the RPC's own gas estimate and reads the block from the receipt.
//
// Options
//   --rpc <url>          the chain's RPC (required)
//   --owner <address|self>  who may withdraw protocol fees. REQUIRED on real networks: use your own wallet or a multisig,
//                        not the deployer key. (On a local anvil it defaults to the deployer.)
//   --launch-fee-wei <n> per-launch fee in wei (default 0 = free). Immutable once deployed.
//   --key-file <path>    JSON file with {"privateKey": "0x..."} (default ~/.elytheia/elysium-deployer.json, outside the
//                        project folder on purpose: a dev server can serve files from inside it).
//                        Env DEPLOYER_KEY is used instead if set (handy for a local anvil).
//   --env-path <path>    where --write-env puts HYP_LAUNCHPAD / HYP_START_BLOCK (default .env)
//   --dry-run            simulate the deploy and print the cost; sends nothing
//   --check              show which wallet the key belongs to and its balance, then stop (sends nothing)
//   --yes                skip the "type DEPLOY" confirmation (it always asks on a real network otherwise)
//   --write-env          after a successful deploy, set HYP_LAUNCHPAD and HYP_START_BLOCK in the env file
//
// Any chain other than a local anvil (31337) and the HyperEVM testnet (998) is real money and needs ALLOW_MAINNET=1,
// because the contracts are unaudited.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeDeployData,
  formatEther,
  formatGwei,
  getAddress,
  http,
  isAddress,
  parseEther,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const require = createRequire(import.meta.url);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
// errors unwind normally (no process.exit, which trips a libuv assertion on Windows while connections are closing)
class Fail extends Error {}
const fail = (msg) => {
  throw new Fail(msg);
};

async function main() {
const rpc = arg('rpc');
if (!rpc || rpc === true) fail('--rpc <url> is required');
const dryRun = arg('dry-run', false) === true;
const writeEnv = arg('write-env', false) === true;
const envFile = path.resolve(String(arg('env-path', '.env')));
const keyFile = path.resolve(String(arg('key-file', path.join(os.homedir(), '.elytheia', 'elysium-deployer.json'))));
const launchFee = BigInt(String(arg('launch-fee-wei', '0')));
// start-market-cap tiers in whole HYPE, immutable once deployed (the site reads them from the contract). Default: one tier of
// 35.6 HYPE, about $2.75K at HYPE $77. Keep in sync with CHAINS.hyp in shared/market.ts (only used before the chain has been read).
const tierArg = String(arg('tiers', '35.6'));
if (!/^\d+(\.\d+)?(,\d+(\.\d+)?)*$/.test(tierArg) || tierArg.split(',').length > 8) fail('--tiers must be 1 to 8 comma-separated HYPE amounts, e.g. 35.6 or 35.6,71,142');

// ---- chain
const probe = createPublicClient({ transport: http(rpc) });
const chainId = await probe.getChainId().catch((e) => fail(`cannot reach ${rpc}: ${e.shortMessage || e.message}`));
const testNetwork = chainId === 31337 || chainId === 998;
if (!testNetwork && process.env.ALLOW_MAINNET !== '1') {
  fail(`chain ${chainId} is a real-money network and these contracts are unaudited.\nRe-run with ALLOW_MAINNET=1 to confirm you accept that.`);
}
const chain = defineChain({ id: chainId, name: `chain ${chainId}`, nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const pub = createPublicClient({ chain, transport: http(rpc) });

// ---- who
let account = null;
if (!dryRun) {
  let pk = process.env.DEPLOYER_KEY;
  if (!pk) {
    if (!fs.existsSync(keyFile)) fail(`no deployer key: ${keyFile} does not exist (or set DEPLOYER_KEY)`);
    // the file is either JSON {"privateKey": "..."} or plain text with the key on its own line ('#' lines are comments)
    const raw = fs.readFileSync(keyFile, 'utf8');
    try {
      pk = JSON.parse(raw).privateKey;
    } catch {
      pk = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    }
    if (!pk) fail(`${keyFile} has no key in it yet: paste your private key on its own line, save the file, and run this again`);
  }
  pk = String(pk).trim();
  if (/^[0-9a-fA-F]{64}$/.test(pk)) pk = `0x${pk}`; // wallets such as MetaMask export it without the 0x
  try {
    account = privateKeyToAccount(pk);
  } catch {
    fail('the deployer key is not a valid private key');
  }
}
// a dry run needs no key: simulate from any address
const from = account?.address ?? '0x000000000000000000000000000000000000dEaD';

// --check: show which wallet the key belongs to and what it holds on this chain, then stop. Sends nothing.
if (arg('check', false) === true) {
  if (!account) fail('--check needs the key (do not combine it with --dry-run)');
  const bal = await pub.getBalance({ address: from });
  console.log(`
  chain ${chainId}
  this key belongs to  ${from}
  balance              ${formatEther(bal)} HYPE

  Nothing was sent.
`);
  return;
}

const ownerArg = arg('owner');
let owner;
if (ownerArg === 'self') {
  owner = from; // the wallet whose key is being used (shown in the summary below)
} else if (ownerArg && ownerArg !== true) {
  if (!isAddress(ownerArg)) fail('--owner is not a valid address');
  owner = getAddress(ownerArg);
} else if (testNetwork) {
  owner = from;
} else {
  fail('--owner <address> is required on a real network: the owner can withdraw protocol fees, so use YOUR wallet or a multisig, not the deployer key.');
}
if (owner === zeroAddress) fail('--owner cannot be the zero address');

// ---- contract
const artPath = path.resolve('contracts/out/Launchpad.sol/Launchpad.json');
if (!fs.existsSync(artPath)) fail('contract not compiled: run `cd contracts && forge build` first');
const art = require(artPath);
const tiers = tierArg.split(',').map((t) => parseEther(t));
const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode.object, args: [owner, launchFee, tiers] });

// ---- simulate (nothing is sent)
const sim = await pub.call({ account: from, data }).catch((e) => fail(`the deploy would revert: ${e.shortMessage || e.message}`));
const runtimeBytes = (sim.data.length - 2) / 2;
const gas = await pub.estimateGas({ account: from, data }).catch((e) => fail(`gas estimate failed: ${e.shortMessage || e.message}`));
const gasPrice = await pub.getGasPrice();
const cost = gas * gasPrice;
const limit = (gas * 125n) / 100n; // 25% headroom over the RPC's own estimate

console.log(`
  chain          ${chainId}${testNetwork ? ' (test network)' : ' (REAL MONEY)'}
  rpc            ${rpc}
  deployer       ${account ? from : '(dry run: no key used)'}
  owner          ${owner}${owner === from ? '   <- same as the deployer' : ''}
  launch fee     ${launchFee === 0n ? 'free' : formatEther(launchFee) + ' per launch'}
  start mcap     ${tierArg.split(',').join(' / ')} HYPE
  runtime code   ${runtimeBytes} bytes (limit 24576)
  gas            ${gas} (limit ${limit}) @ ${formatGwei(gasPrice)} gwei
  expected cost  ${formatEther(cost)} HYPE (up to ${formatEther(limit * gasPrice)} at the limit)
`);

if (dryRun) {
  console.log('Dry run only: nothing was sent.\n');
  return;
}

const balance = await pub.getBalance({ address: from });
console.log(`  deployer balance  ${formatEther(balance)} HYPE`);
if (balance < limit * gasPrice) fail(`the deployer needs at least ${formatEther(limit * gasPrice)} HYPE on chain ${chainId} (has ${formatEther(balance)}). Send some to ${from} and re-run.`);

// ---- confirm (real networks always ask; --yes skips it; --confirm forces it on a test network)
if ((!testNetwork || arg('confirm', false) === true) && arg('yes', false) !== true) {
  // on a real network a person must be at the keyboard: no piping "DEPLOY" in from another program
  if (!process.stdin.isTTY && !testNetwork) fail('this needs an interactive terminal to confirm (or pass --yes)');
  const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`  Deploy from ${from} with owner ${owner} on chain ${chainId}? Type DEPLOY to send: `)).trim();
  rl.close();
  if (answer !== 'DEPLOY') fail('cancelled: nothing was sent');
}

// ---- send
const wallet = createWalletClient({ account, chain, transport: http(rpc) });
console.log('  sending the deploy transaction…');
const hash = await wallet.sendTransaction({ data, gas: limit }).catch((e) => fail(`the RPC refused the transaction: ${e.details || e.shortMessage || String(e.message).split('\n')[0]}`));
console.log(`  tx             ${hash}`);
const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
if (receipt.status !== 'success' || !receipt.contractAddress) fail(`deploy transaction failed (status ${receipt.status}): ${hash}`);

// ---- verify what is actually on-chain
const address = getAddress(receipt.contractAddress);
const code = await pub.getCode({ address });
if (!code || (code.length - 2) / 2 !== runtimeBytes) fail(`code at ${address} is not what was simulated`);
const onOwner = await pub.readContract({ address, abi: art.abi, functionName: 'owner' });
const onFee = await pub.readContract({ address, abi: art.abi, functionName: 'launchFee' });
if (getAddress(onOwner) !== owner || onFee !== launchFee) fail(`on-chain owner/fee do not match (${onOwner}, ${onFee})`);
const onTiers = await pub.readContract({ address, abi: art.abi, functionName: 'startMcapTiers' });
if (onTiers.length !== tiers.length || onTiers.some((t, i) => t !== tiers[i])) fail(`on-chain tiers do not match (${onTiers.join(',')})`);

// receipt.blockNumber is the chain's own (L2) block number, which is what the indexer reads
console.log(`
  Launchpad deployed
  address        ${address}
  deploy block   ${receipt.blockNumber}
  gas used       ${receipt.gasUsed}  (paid ${formatEther(receipt.gasUsed * receipt.effectiveGasPrice)} HYPE)
  owner/fee/tiers verified on-chain
`);

if (writeEnv) {
  let text = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  text = text
    .split(/\r?\n/)
    .filter((l) => !/^\s*(HYP_LAUNCHPAD|HYP_START_BLOCK)\s*=/.test(l))
    .join('\n')
    .replace(/\n*$/, '\n');
  text += `HYP_LAUNCHPAD=${address}\nHYP_START_BLOCK=${receipt.blockNumber}\n`;
  fs.writeFileSync(envFile, text);
  console.log(`  wrote HYP_LAUNCHPAD and HYP_START_BLOCK to ${envFile}. Restart the server to pick them up.\n`);
} else {
  console.log(`  Put these in .env, then restart the server:\n    HYP_LAUNCHPAD=${address}\n    HYP_START_BLOCK=${receipt.blockNumber}\n`);
}
}

main().catch((e) => {
  console.error(e instanceof Fail ? `\nERROR: ${e.message}\n` : e);
  process.exitCode = 1;
});
