// A small real-money smoke test of the DEPLOYED Launchpad: launch a test coin (no first buy), buy a tiny amount, sell half
// back, then check the contract's books balance. It spends real HYPE (a few thousandths) and leaves a permanent coin behind.
//
//   ALLOW_MAINNET=1 node scripts/smoke-evm.mjs --rpc https://heliosliq.app/rpc --launchpad 0x... [--key-file <path>] [--buy 0.002]
//
// The key is read from the same file the deploy script uses (default ~/.elytheia/elysium-deployer.json); it is never printed.
// A name + ticker can only be launched once (AntiVamp), so this can only be run once per launchpad unless --symbol is changed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createPublicClient, createWalletClient, defineChain, formatEther, getAddress, http, parseEther, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const require = createRequire(import.meta.url);
const art = require(path.resolve('contracts/out/Launchpad.sol/Launchpad.json'));
const erc20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
class Fail extends Error {}
const fail = (m) => {
  throw new Fail(m);
};
const short = (e) => e.details || e.shortMessage || String(e.message).split('\n')[0];

async function main() {
  const rpc = arg('rpc');
  const launchpad = arg('launchpad');
  if (!rpc || !launchpad) fail('--rpc and --launchpad are required');
  const probe = createPublicClient({ transport: http(rpc) });
  const chainId = await probe.getChainId();
  if (chainId !== 31337 && chainId !== 998 && process.env.ALLOW_MAINNET !== '1') fail(`chain ${chainId} is real money: re-run with ALLOW_MAINNET=1`);
  const chain = defineChain({ id: chainId, name: `chain ${chainId}`, nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });

  let pk = process.env.DEPLOYER_KEY;
  if (!pk) {
    const keyFile = path.resolve(arg('key-file', path.join(os.homedir(), '.elytheia', 'elysium-deployer.json')));
    if (!fs.existsSync(keyFile)) fail(`no key file at ${keyFile}`);
    const raw = fs.readFileSync(keyFile, 'utf8');
    try {
      pk = JSON.parse(raw).privateKey;
    } catch {
      pk = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    }
  }
  pk = String(pk || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(pk)) pk = `0x${pk}`;
  let account;
  try {
    account = privateKeyToAccount(pk);
  } catch {
    fail('not a valid private key');
  }

  const address = getAddress(launchpad);
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  const code = await pub.getCode({ address });
  if (!code || code === '0x') fail(`no contract at ${address} on chain ${chainId}`);

  const read = (functionName, args = []) => pub.readContract({ address, abi: art.abi, functionName, args });
  const buyAmount = parseEther(String(arg('buy', '0.002')));
  if (buyAmount > parseEther('0.01')) fail('--buy is capped at 0.01 HYPE for a smoke test');
  const symbol = String(arg('symbol', 'ETEST')).toUpperCase();

  const startBalance = await pub.getBalance({ address: account.address });
  const owner = await read('owner');
  const fee = await read('launchFee');
  console.log(`\n  chain ${chainId}  launchpad ${address}\n  tester ${account.address}  balance ${formatEther(startBalance)} HYPE\n  owner  ${owner}  launch fee ${fee === 0n ? 'free' : formatEther(fee)}\n`);

  const step = async (label, functionName, args, value = 0n) => {
    try {
      const { request } = await pub.simulateContract({ address, abi: art.abi, functionName, args, value, account });
      const hash = await wallet.writeContract(request);
      const rc = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (rc.status !== 'success') fail(`${label}: transaction reverted (${hash})`);
      console.log(`  ok  ${label.padEnd(34)} gas ${String(rc.gasUsed).padStart(8)}  ${hash}`);
      return rc;
    } catch (e) {
      if (e instanceof Fail) throw e;
      return fail(`${label}: ${short(e)}`);
    }
  };

  // 1) launch a coin with no first buy
  const created = await step(`create coin ${symbol}`, 'createCoin', [{ name: 'Elytheia Test', symbol, metadataURI: '', tier: 0, mode: 0, firstBuy: 0n }], fee);
  const ev = parseEventLogs({ abi: art.abi, logs: created.logs, eventName: 'CoinCreated' })[0];
  if (!ev) fail('the CoinCreated event was not emitted');
  const id = ev.args.id;
  const info = await read('coinInfo', [id]);
  console.log(`      coin id ${id}, token ${info.token}`);

  // 2) buy a tiny amount
  await step(`buy ${formatEther(buyAmount)} HYPE`, 'buy', [id, 0n], buyAmount);
  const tokens = await pub.readContract({ address: info.token, abi: erc20, functionName: 'balanceOf', args: [account.address] });
  if (tokens === 0n) fail('bought, but the token balance is still zero');
  console.log(`      holding ${tokens} token base units`);

  // 3) sell half back
  await step('sell half back', 'sell', [id, tokens / 2n, 0n]);
  const left = await pub.readContract({ address: info.token, abi: erc20, functionName: 'balanceOf', args: [account.address] });
  if (left !== tokens - tokens / 2n) fail(`unexpected balance after selling: ${left}`);

  // 4) the contract must hold at least everything it owes
  const fin = await read('coinInfo', [id]);
  const protocol = await read('protocolFees');
  const bal = await pub.getBalance({ address });
  const owed = fin.realQuote + fin.creatorFees + (fin.holderFeesTotal - fin.holderClaimed) + protocol;
  console.log(`\n  contract balance ${formatEther(bal)} HYPE, owed ${formatEther(owed)} HYPE  ->  ${bal >= owed ? 'books balance' : 'SHORTFALL'}`);
  if (bal < owed) fail('the contract owes more than it holds');
  if (protocol === 0n) fail('no protocol fee was recorded');

  const endBalance = await pub.getBalance({ address: account.address });
  console.log(`  protocol fees accrued ${formatEther(protocol)} HYPE (withdrawable by the owner)`);
  console.log(`  tester spent in total ${formatEther(startBalance - endBalance)} HYPE (gas + ${formatEther(buyAmount)} bought, part of it sold back)\n\n  SMOKE TEST PASSED\n`);
}

main().catch((e) => {
  console.error(e instanceof Fail ? `\nFAILED: ${e.message}\n` : e);
  process.exitCode = 1;
});
