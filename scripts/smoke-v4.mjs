// Real-money smoke test of a DEPLOYED v4 launch stack: launch a coin with a first buy, buy and sell through the launchpad,
// buy through UNISWAP'S OWN Universal Router, then collect and claim fees and reconcile the whole supply.
//
//   ALLOW_MAINNET=1 node scripts/smoke-v4.mjs --rpc <rpc> --launchpad 0x... [--key-file <path>] [--amount 0.002] [--symbol ETV4]
//
// It spends a few thousandths of HYPE and leaves one permanent coin behind. A name + ticker can only be launched once.
import { encodeAbiParameters, formatEther, getAddress, parseEther, parseEventLogs } from 'viem';
import { arg, artifact, connect, fail, loadAccount, run, short } from './lib/tools.mjs';

const UNIVERSAL_ROUTERS = { 99901: '0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a' };
const POOL_KEY = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
];
const erc20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];

run(async () => {
  const rpc = arg('rpc');
  const launchpad = arg('launchpad');
  if (!rpc || !launchpad || rpc === true || launchpad === true) fail('--rpc and --launchpad are required');
  const account = loadAccount();
  const { chainId, pub, wallet } = await connect(rpc, account);
  const art = artifact('V4Launchpad', 'V4Launchpad');
  const pad = getAddress(launchpad);
  const code = await pub.getCode({ address: pad });
  if (!code || code === '0x') fail(`no contract at ${pad} on chain ${chainId}`);

  const amount = parseEther(String(arg('amount', '0.002')));
  if (amount > parseEther('0.01')) fail('--amount is capped at 0.01 HYPE for a smoke test');
  const symbol = String(arg('symbol', 'ETV4')).toUpperCase();
  const read = (functionName, args = []) => pub.readContract({ address: pad, abi: art.abi, functionName, args });
  const poolManager = await read('poolManager');
  const router = UNIVERSAL_ROUTERS[chainId];

  const start = await pub.getBalance({ address: account.address });
  const fee = await read('launchFee');
  console.log(`\n  chain ${chainId}  launchpad ${pad}\n  tester ${account.address}  balance ${formatEther(start)} HYPE\n  start market cap ${formatEther(await read('startMarketCap'))} HYPE, launch fee ${fee === 0n ? 'free' : formatEther(fee)}\n`);

  const step = async (label, tx) => {
    try {
      const hash = await wallet.sendTransaction({ ...tx, gas: tx.gas });
      const rc = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (rc.status !== 'success') fail(`${label}: transaction reverted (${hash})`);
      console.log(`  ok  ${label.padEnd(40)} gas ${String(rc.gasUsed).padStart(8)}  ${hash}`);
      return rc;
    } catch (e) {
      if (e?.constructor?.name === 'Fail') throw e;
      return fail(`${label}: ${short(e)}`);
    }
  };
  const call = async (label, functionName, args, value = 0n) => {
    const { request } = await pub.simulateContract({ address: pad, abi: art.abi, functionName, args, value, account }).catch((e) => fail(`${label}: would revert: ${short(e)}`));
    const hash = await wallet.writeContract(request).catch((e) => fail(`${label}: ${short(e)}`));
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (rc.status !== 'success') fail(`${label}: transaction reverted (${hash})`);
    console.log(`  ok  ${label.padEnd(40)} gas ${String(rc.gasUsed).padStart(8)}  ${hash}`);
    return rc;
  };

  // 1) launch with a first buy
  const created = await call(`create ${symbol} + launch buy ${formatEther(amount)}`, 'createCoin', [{ name: 'Elytheia V4 Test', symbol, metadataURI: '', firstBuy: amount }], fee + amount);
  const ev = parseEventLogs({ abi: art.abi, logs: created.logs, eventName: 'CoinCreated' })[0];
  if (!ev) fail('the CoinCreated event was not emitted');
  const id = ev.args.id;
  const info = await read('coinInfo', [id]);
  const token = info.token;
  const bal = () => pub.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [account.address] });
  console.log(`      coin ${id}, token ${token}, pool ${info.poolId}`);
  const afterLaunch = await bal();
  if (afterLaunch === 0n) fail('the launch buy delivered no tokens');
  console.log(`      launch buy -> ${afterLaunch} token units`);

  // 2) buy through the launchpad (this is inside the anti-snipe window, so it pays the surcharge)
  await call(`buy ${formatEther(amount)} via launchpad`, 'buy', [id, 0n], amount);
  const afterBuy = await bal();
  if (afterBuy <= afterLaunch) fail('the buy delivered no tokens');

  // 3) buy through Uniswap's own Universal Router: exactly what any Uniswap front-end would send
  if (router) {
    const key = await read('poolKeyOf', [id]);
    const swap = encodeAbiParameters(
      [{ type: 'tuple', components: [{ name: 'poolKey', type: 'tuple', components: POOL_KEY }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'minHopPriceX36', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] }],
      [{ poolKey: key, zeroForOne: true, amountIn: amount, amountOutMinimum: 0n, minHopPriceX36: 0n, hookData: '0x' }],
    );
    const params = [swap, encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key.currency0, amount]), encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key.currency1, 0n])];
    const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ['0x060c0f', params]);
    const routerAbi = [{ type: 'function', name: 'execute', stateMutability: 'payable', inputs: [{ name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }, { name: 'deadline', type: 'uint256' }], outputs: [] }];
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const { request } = await pub.simulateContract({ address: router, abi: routerAbi, functionName: 'execute', args: ['0x10', [input], deadline], value: amount, account }).catch((e) => fail(`Uniswap Universal Router buy would revert: ${short(e)}`));
    const hash = await wallet.writeContract(request).catch((e) => fail(`Universal Router buy: ${short(e)}`));
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (rc.status !== 'success') fail(`Universal Router buy reverted (${hash})`);
    console.log(`  ok  ${('buy ' + formatEther(amount) + ' via UNISWAP ROUTER').padEnd(40)} gas ${String(rc.gasUsed).padStart(8)}  ${hash}`);
    if ((await bal()) <= afterBuy) fail('the Uniswap router buy delivered no tokens');
  } else console.log(`  (no known Universal Router for chain ${chainId}: skipping the router buy)`);
  const holding = await bal();

  // 4) sell half back through the launchpad
  await call('sell half back via launchpad', 'sell', [id, holding / 2n, 0n]);
  const afterSell = await bal();
  if (afterSell !== holding - holding / 2n) fail(`unexpected balance after selling: ${afterSell}`);

  // 5) fees: collect, check the split, claim the creator's half
  await call('collect fees', 'collectFees', [id]);
  const v = await read('coinInfo', [id]);
  const protocolNative = await read('protocolNative');
  console.log(`      fees: creator ${formatEther(v.creatorNative)} HYPE + ${v.creatorToken} token units; protocol ${formatEther(protocolNative)} HYPE`);
  if (v.creatorNative === 0n && v.creatorToken === 0n) fail('no fees were collected');
  if (protocolNative < v.creatorNative - 1n) fail('the protocol share is smaller than the creator share');
  await call('claim creator fees', 'claim', [id]);
  if ((await read('coinInfo', [id])).creatorNative !== 0n) fail('creator fees were not paid out');

  // 6) every token unit is accounted for: the pool manager holds the pool, the tester holds the rest
  const total = await pub.readContract({ address: token, abi: erc20, functionName: 'totalSupply' });
  const inPool = await pub.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [poolManager] });
  const inPad = await pub.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [pad] });
  const mine = await bal();
  const sum = inPool + inPad + mine;
  console.log(`\n  supply ${total}: pool ${inPool} + launchpad ${inPad} + tester ${mine} = ${sum}  ->  ${sum === total ? 'every unit accounted for' : 'MISMATCH'}`);
  if (sum !== total) fail('the token supply does not add up');
  const [sqrtP, tick, vq, vt] = await read('marketState', [id]);
  console.log(`  pool now: tick ${tick}, virtual reserves ${formatEther(vq)} HYPE / ${vt} token units`);
  const end = await pub.getBalance({ address: account.address });
  console.log(`  tester spent in total ${formatEther(start - end)} HYPE (gas + the trades, partly sold back)\n\n  V4 SMOKE TEST PASSED\n`);
});
