// Deploys the Uniswap v4 launch stack (anti-snipe hook + V4Launchpad) and wires it together.
//
//   ALLOW_MAINNET=1 node scripts/deploy-v4.mjs --rpc https://heliosliq.app/rpc --owner self --dry-run
//   ALLOW_MAINNET=1 node scripts/deploy-v4.mjs --rpc https://heliosliq.app/rpc --owner self --yes
//
// What it does, in order (each step is verified on-chain before the next):
//   1. mines a CREATE2 salt so the hook's address carries exactly the BEFORE_SWAP permission bit, deploys the hook
//      through the standard deterministic deployer (0x4e59...956C)
//   2. deploys V4Launchpad(owner, poolManager, hook, launchFee, startTick)
//   3. calls hook.setFactory(launchpad), a one-time call that can never be repeated
//   4. writes the record to deployments/<chainId>-v4.json
//
// Options: --rpc <url>  --owner <address|self>  --start-mcap <HYPE> (default 35.6)  --launch-fee-wei <n> (default 0)
//          --pool-manager <address> (defaults to Uniswap's official deployment on that chain)
//          --record <path> (where to write the deployment record; default deployments/<chainId>-v4.json)
//          --key-file <path>  --dry-run  --yes (skip the "type DEPLOY" prompt; always asked on a real network otherwise)
import fs from 'node:fs';
import path from 'node:path';
import {
  concatHex,
  encodeDeployData,
  encodeFunctionData,
  formatEther,
  getAddress,
  getCreate2Address,
  isAddress,
  keccak256,
  pad,
  toHex,
  zeroAddress,
} from 'viem';
import { arg, artifact, connect, fail, loadAccount, run, short } from './lib/tools.mjs';

// Uniswap's official PoolManager per chain (Elysium: from Uniswap/contracts, verified on-chain byte-for-byte against HyperEVM's)
const POOL_MANAGERS = {
  99901: '0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1',
  999: '0x12D4Fd9C5DeDd00ab8a0bCe2CF0167bbf94b6B1F',
};
const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
const BEFORE_SWAP_FLAG = 1n << 7n;
const ALL_HOOK_MASK = (1n << 14n) - 1n;
const TICK_SPACING = 60;
const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 6n; // token base units (6 decimals)

run(async () => {
  const rpc = arg('rpc');
  if (!rpc || rpc === true) fail('--rpc <url> is required');
  const dryRun = arg('dry-run', false) === true;
  const account = dryRun ? null : loadAccount();
  const { chainId, pub, wallet, testNetwork } = await connect(rpc, account);

  const pmArg = arg('pool-manager');
  const poolManager = pmArg && pmArg !== true ? pmArg : POOL_MANAGERS[chainId];
  if (!poolManager || !isAddress(poolManager)) fail(`no Uniswap PoolManager known for chain ${chainId}: pass --pool-manager <address>`);
  const pmCode = await pub.getCode({ address: poolManager });
  if (!pmCode || pmCode === '0x') fail(`no contract at the PoolManager address ${poolManager} on chain ${chainId}`);
  const deployerCode = await pub.getCode({ address: CREATE2_DEPLOYER });
  if (!deployerCode || deployerCode === '0x') fail(`the standard CREATE2 deployer is not on chain ${chainId}`);

  const from = account?.address ?? '0x000000000000000000000000000000000000dEaD';
  const ownerArg = arg('owner');
  let owner;
  if (ownerArg === 'self') owner = from;
  else if (ownerArg && ownerArg !== true) {
    if (!isAddress(ownerArg)) fail('--owner is not a valid address');
    owner = getAddress(ownerArg);
  } else fail('--owner <address|self> is required: the owner can withdraw protocol fees, so use YOUR wallet or a multisig.');
  if (owner === zeroAddress) fail('--owner cannot be the zero address');

  // start price: market cap in HYPE -> tick (token units per wei = supply / mcap), snapped to the tick spacing
  const startMcap = Number(arg('start-mcap', '35.6'));
  if (!(startMcap > 0)) fail('--start-mcap must be a positive number of HYPE');
  const priceTokensPerWei = Number(TOTAL_SUPPLY) / (startMcap * 1e18);
  const startTick = Math.round(Math.log(priceTokensPerWei) / Math.log(1.0001) / TICK_SPACING) * TICK_SPACING;
  const realMcap = Number(TOTAL_SUPPLY) / 1.0001 ** startTick / 1e18;
  const launchFee = BigInt(String(arg('launch-fee-wei', '0')));

  const hookArt = artifact('AntiSnipeHook', 'AntiSnipeHook');
  const padArt = artifact('V4Launchpad', 'V4Launchpad');

  // ---- 1. mine the hook salt
  const hookInit = encodeDeployData({ abi: hookArt.abi, bytecode: hookArt.bytecode.object, args: [poolManager, from] });
  const initHash = keccak256(hookInit);
  let salt = 0n;
  let hookAddr;
  for (;; salt++) {
    const saltHex = pad(toHex(salt), { size: 32 });
    hookAddr = getCreate2Address({ from: CREATE2_DEPLOYER, salt: saltHex, bytecodeHash: initHash });
    if ((BigInt(hookAddr) & ALL_HOOK_MASK) === BEFORE_SWAP_FLAG) break;
    if (salt > 5_000_000n) fail('could not mine a hook address');
  }
  const saltHex = pad(toHex(salt), { size: 32 });
  const hookTx = { to: CREATE2_DEPLOYER, data: concatHex([saltHex, hookInit]) };

  // ---- simulate / price both deployments
  const padInit = encodeDeployData({ abi: padArt.abi, bytecode: padArt.bytecode.object, args: [owner, poolManager, hookAddr, launchFee, startTick] });
  const gasHook = await pub.estimateGas({ account: from, ...hookTx }).catch((e) => fail(`the hook deployment would fail: ${short(e)}`));
  const gasPad = await pub.estimateGas({ account: from, data: padInit }).catch((e) => fail(`the launchpad deployment would fail: ${short(e)}`));
  const gasPrice = await pub.getGasPrice();
  const total = (gasHook + gasPad + 200_000n) * gasPrice;

  console.log(`
  chain          ${chainId}${testNetwork ? ' (test network)' : ' (REAL MONEY)'}
  rpc            ${rpc}
  deployer       ${account ? from : '(dry run: no key used)'}
  owner          ${owner}${owner === from ? '   <- same as the deployer' : ''}
  pool manager   ${getAddress(poolManager)}  (${(pmCode.length - 2) / 2} bytes)
  hook address   ${hookAddr}  (salt ${salt}; low bits 0x${(BigInt(hookAddr) & ALL_HOOK_MASK).toString(16)} = BEFORE_SWAP only)
  start price    tick ${startTick}  ->  market cap ${realMcap.toFixed(3)} HYPE  (target ${startMcap})
  launch fee     ${launchFee === 0n ? 'free' : formatEther(launchFee) + ' per launch'}
  gas            hook ${gasHook} + launchpad ${gasPad} + wiring ~200000  @ ${Number(gasPrice) / 1e9} gwei
  expected cost  ${formatEther(total)} HYPE
`);
  if (dryRun) {
    console.log('Dry run only: nothing was sent.\n');
    return;
  }

  const balance = await pub.getBalance({ address: from });
  console.log(`  deployer balance  ${formatEther(balance)} HYPE`);
  if (balance < total * 2n) fail(`the deployer needs at least ${formatEther(total * 2n)} HYPE (has ${formatEther(balance)})`);

  if (!testNetwork || arg('confirm', false) === true) {
    if (arg('yes', false) !== true) {
      if (!process.stdin.isTTY && !testNetwork) fail('this needs an interactive terminal to confirm (or pass --yes)');
      const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question('  Type DEPLOY to send these transactions: ')).trim();
      rl.close();
      if (answer !== 'DEPLOY') fail('cancelled: nothing was sent');
    }
  }

  const wait = (hash) => pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  const send = async (label, tx, gas) => {
    const hash = await wallet.sendTransaction({ ...tx, gas: (gas * 125n) / 100n }).catch((e) => fail(`${label}: the RPC refused the transaction: ${short(e)}`));
    const rc = await wait(hash);
    if (rc.status !== 'success') fail(`${label}: transaction reverted (${hash})`);
    console.log(`  ok  ${label.padEnd(24)} ${hash}  (gas ${rc.gasUsed})`);
    return { hash, rc };
  };

  // ---- 1. hook
  const h = await send('deploy hook', hookTx, gasHook);
  const hookCode = await pub.getCode({ address: hookAddr });
  if (!hookCode || hookCode === '0x') fail(`no hook code at the predicted address ${hookAddr}`);
  if (getAddress(await pub.readContract({ address: hookAddr, abi: hookArt.abi, functionName: 'poolManager' })) !== getAddress(poolManager)) fail('hook is wired to the wrong pool manager');

  // ---- 2. launchpad
  const l = await send('deploy launchpad', { data: padInit }, gasPad);
  const launchpad = getAddress(l.rc.contractAddress);

  // ---- 3. wire the hook to the launchpad (one-time)
  const gasSet = await pub.estimateGas({ account: from, to: hookAddr, data: encodeFunctionData({ abi: hookArt.abi, functionName: 'setFactory', args: [launchpad] }) }).catch((e) => fail(`setFactory would fail: ${short(e)}`));
  const w = await send('hook.setFactory', { to: hookAddr, data: encodeFunctionData({ abi: hookArt.abi, functionName: 'setFactory', args: [launchpad] }) }, gasSet);

  // ---- verify the finished system, from the chain
  const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
  const checks = [
    ['launchpad.hook == hook', getAddress(await read(launchpad, padArt.abi, 'hook')) === getAddress(hookAddr)],
    ['launchpad.poolManager == official', getAddress(await read(launchpad, padArt.abi, 'poolManager')) === getAddress(poolManager)],
    ['hook.factory == launchpad', getAddress(await read(hookAddr, hookArt.abi, 'factory')) === launchpad],
    ['launchpad.owner == owner', getAddress(await read(launchpad, padArt.abi, 'owner')) === owner],
    ['launch fee', (await read(launchpad, padArt.abi, 'launchFee')) === launchFee],
    ['start tick', Number(await read(launchpad, padArt.abi, 'startTick')) === startTick],
    ['start market cap within 1% of target', Math.abs(Number(await read(launchpad, padArt.abi, 'startMarketCap')) / 1e18 / startMcap - 1) < 0.01],
  ];
  let bad = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? 'verified' : 'MISMATCH'}  ${label}`);
    if (!ok) bad++;
  }
  if (bad) fail(`${bad} on-chain check(s) failed: do not use this deployment`);

  const record = {
    chainId,
    deployedAt: new Date().toISOString(),
    poolManager: getAddress(poolManager),
    hook: getAddress(hookAddr),
    launchpad,
    owner,
    deployer: from,
    startTick,
    startMarketCapHype: realMcap,
    launchFeeWei: launchFee.toString(),
    deployBlock: Number(l.rc.blockNumber),
    transactions: { hook: h.hash, launchpad: l.hash, setFactory: w.hash },
  };
  const recArg = arg('record');
  const outFile = recArg && recArg !== true ? path.resolve(recArg) : path.resolve('deployments', `${chainId}-v4.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2) + '\n');
  console.log(`
  V4 launch stack deployed
  launchpad      ${launchpad}
  hook           ${hookAddr}
  deploy block   ${record.deployBlock}
  record         ${outFile}
`);
});
