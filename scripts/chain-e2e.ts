/**
 * End-to-end test of the Uniswap v4 launchpad: a fork of the real Elysium chain (anvil), the v4 stack deployed on it by
 * scripts/deploy-v4.mjs, this site's real server indexing it, and wallets driving everything.
 *
 *   npm run chain:test        (starts and stops everything itself)
 *
 * Uses anvil's public development keys: they only mean anything on a local throwaway chain.
 */
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, getAddress, http, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { launchpadAbi } from '../shared/launchpadAbi';
import { tokenAbi } from '../shared/v4Abi';

const API = process.env.API || 'http://localhost:8790';
const RPC = process.env.RPC || 'http://127.0.0.1:8545';
const PAD = process.env.PAD as `0x${string}`;
const POOL_MANAGER = '0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1';
const ROUTER = '0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a'; // Uniswap's Universal Router v2.2 on Elysium
if (!PAD) throw new Error('PAD (the launchpad address) is required: run `npm run chain:test`');

const KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // deployer / owner
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // creator
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // alice
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', // bob
];
const [, creator, alice, bob] = KEYS.map((k) => privateKeyToAccount(k));
type Acct = ReturnType<typeof privateKeyToAccount>;

const chain = defineChain({ id: 99901, name: 'Elysium (fork)', nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = (acct: Acct) => createWalletClient({ account: acct, chain, transport: http(RPC) });

let failed = 0;
function check(name: string, cond: unknown, extra?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ ${name}`, extra ?? '');
  }
}

async function api(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(API + path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

async function send(acct: Acct, fn: string, args: unknown[], value = 0n) {
  const hash = await wallet(acct).writeContract({ address: PAD, abi: launchpadAbi, functionName: fn as any, args: args as any, value });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`${fn} reverted`);
  return rc;
}

async function jump(seconds: number) {
  await pub.request({ method: 'evm_increaseTime' as any, params: [seconds] as any });
  await pub.request({ method: 'evm_mine' as any, params: [] as any });
}

async function login(acct: Acct) {
  const n = await api('/api/auth/nonce', { body: { address: acct.address } });
  const signature = await acct.signMessage({ message: n.json.message });
  const v = await api('/api/auth/verify', { body: { address: acct.address, nonce: n.json.nonce, signature } });
  return { ...v, token: v.json.token as string, nonce: n.json, signature };
}

const sync = () => api('/api/chain/sync', { body: {} });
const balanceOf = (token: `0x${string}`, who: `0x${string}`) => pub.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [who] }) as Promise<bigint>;

const POOL_KEY = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;

/** exactly what a Uniswap front-end sends: V4_SWAP -> SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL */
async function routerBuy(acct: Acct, key: any, amountIn: bigint) {
  const swap = encodeAbiParameters(
    [{ type: 'tuple', components: [{ name: 'poolKey', type: 'tuple', components: POOL_KEY }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'minHopPriceX36', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] }],
    [{ poolKey: key, zeroForOne: true, amountIn, amountOutMinimum: 0n, minHopPriceX36: 0n, hookData: '0x' }],
  );
  const params = [swap, encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key.currency0, amountIn]), encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key.currency1, 0n])];
  const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ['0x060c0f', params]);
  const abi = [{ type: 'function', name: 'execute', stateMutability: 'payable', inputs: [{ name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }, { name: 'deadline', type: 'uint256' }], outputs: [] }] as const;
  const hash = await wallet(acct).writeContract({ address: ROUTER, abi, functionName: 'execute', args: ['0x10', [input], BigInt(Math.floor(Date.now() / 1000) + 3600)], value: amountIn });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('router buy reverted');
}

async function main() {
  console.log(`\nChain E2E → API ${API}, RPC ${RPC}, Launchpad ${PAD}\n`);

  console.log('server in real mode');
  const cfg = await api('/api/config');
  check('config reports the deployed launchpad, its hook and Uniswap\'s pool manager', cfg.json.evm?.enabled && cfg.json.evm?.launchpad?.toLowerCase() === PAD.toLowerCase() && cfg.json.evm?.poolManager?.toLowerCase() === POOL_MANAGER.toLowerCase() && !!cfg.json.evm?.hook, cfg.json.evm);
  const hypChain = cfg.json.chains?.find((c: any) => c.id === 'hyp');
  check('the start market cap is read from the contract (one tier of about 35.65 HYPE)', hypChain?.startMcapTiers?.length === 1 && Math.abs(hypChain.startMcapTiers[0] - 35.65) < 0.1, hypChain?.startMcapTiers);
  check("browser gets the EVM RPC and a same-origin Solana proxy, never the server's Solana RPC", cfg.json.evm?.rpcUrl === RPC && cfg.json.solana?.rpcUrl === '/api/solana-rpc' && !JSON.stringify(cfg.json).includes('api.mainnet-beta.solana.com'));
  for (const p of ['/api/faucet', '/api/swap']) {
    const r = await api(p, { body: {} });
    check(`no simulated-money endpoint ${p}`, r.status === 404, r.json);
  }

  console.log('EVM wallet sign-in');
  const cs = await login(creator);
  check('creator signs in with a personal_sign signature', cs.status === 200 && cs.token, cs.json);
  const forged = await api('/api/auth/verify', { body: { address: alice.address, nonce: (await api('/api/auth/nonce', { body: { address: alice.address } })).json.nonce, signature: cs.signature } });
  check("someone else's signature is rejected", forged.status === 401, forged.json);
  const replay = await api('/api/auth/verify', { body: { address: creator.address, nonce: cs.nonce.nonce, signature: cs.signature } });
  check('a used nonce cannot be replayed', replay.status === 401, replay.json);

  console.log('metadata pipeline');
  const meta = await api('/api/chain/metadata', { token: cs.token, body: { name: 'Chain Test Coin', symbol: 'CTC', description: 'created by the on-chain e2e test', twitter: '@chaintest' } });
  check('metadata published', meta.status === 200 && meta.json.uri?.startsWith(API), meta.json);

  console.log('launch straight onto Uniswap v4 (with a 1 HYPE launch buy)');
  const rc = await send(creator, 'createCoin', [{ name: 'Chain Test Coin', symbol: 'CTC', metadataURI: meta.json.uri, firstBuy: parseEther('1') }], parseEther('1'));
  check('launch transaction mined', rc.status === 'success');
  await sync();
  const list = await api('/api/coins?sort=new&limit=10');
  const coin = list.json.coins.find((c: any) => c.symbol === 'CTC');
  check('indexer picked the coin up', !!coin, list.json.coins?.map((c: any) => c.symbol));
  if (!coin) throw new Error('coin missing; cannot continue');
  check('coin is an EVM pool coin with creator fees', coin.chain === 'hyp' && coin.model === 'pool' && coin.feeMode === 'creator');
  check('creator is the on-chain creator', coin.creator === getAddress(creator.address));
  check('the launch buy was recorded as a trade and the creator holds the tokens', coin.trades === 1 && coin.holders === 1, { trades: coin.trades, holders: coin.holders });

  const info = (await pub.readContract({ address: PAD, abi: launchpadAbi, functionName: 'coinInfo', args: [1n] })) as any;
  check('DB token address == contract token', coin.address === getAddress(info.token));
  const pricesMatch = async (label: string) => {
    const fresh = (await api(`/api/coins/${coin.id}`)).json.coin;
    const [, , vq, vt] = (await pub.readContract({ address: PAD, abi: launchpadAbi, functionName: 'marketState', args: [1n] })) as readonly [bigint, number, bigint, bigint];
    const chainPrice = Number(vq) / 1e18 / (Number(vt) / 1e6); // HYPE per token
    check(`${label}: DB price matches the pool's price on-chain`, Math.abs(fresh.priceQuote / chainPrice - 1) < 0.001, { db: fresh.priceQuote, chain: chainPrice });
    return fresh;
  };
  await pricesMatch('after launch');

  // metadata enrichment runs on a timer: wait for it
  let enriched: any = coin;
  for (let i = 0; i < 20 && !enriched.description; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    enriched = (await api(`/api/coins/${coin.id}`)).json.coin;
  }
  check('description + twitter loaded from the metadata URI', enriched.description === 'created by the on-chain e2e test' && enriched.twitter === 'https://x.com/chaintest', enriched);

  console.log('trading: through the launchpad AND through Uniswap\'s own router');
  await jump(130); // leave the anti-snipe window
  await send(alice, 'buy', [1n, 0n], parseEther('2'));
  const key = await pub.readContract({ address: PAD, abi: launchpadAbi, functionName: 'poolKeyOf', args: [1n] });
  await routerBuy(bob, key, parseEther('1'));
  await sync();
  const afterBuys = await pricesMatch('after buys');
  check('all three buys indexed (launch buy + launchpad buy + router buy)', afterBuys.trades === 3, afterBuys.trades);
  check('three holders', afterBuys.holders === 3, afterBuys.holders);
  const tradeList = (await api(`/api/coins/${coin.id}/trades`)).json.trades as any[];
  const txt = JSON.stringify(tradeList).toLowerCase();
  check('the launchpad buy is attributed to alice', txt.includes(alice.address.toLowerCase()));
  check("the Uniswap-router buy is attributed to bob's wallet, not to the router", txt.includes(bob.address.toLowerCase()) && !txt.includes(ROUTER.toLowerCase()));
  check('all three trades are buys', tradeList.length === 3 && tradeList.every((t) => t.side === 'buy'), tradeList.map((t) => t.side));
  check('price rose after the buys', afterBuys.priceQuote > coin.priceQuote, [coin.priceQuote, afterBuys.priceQuote]);
  check('volume is recorded', afterBuys.volumeUsd > 0, afterBuys.volumeUsd);

  console.log('selling and the anti-snipe window');
  const token = getAddress(info.token);
  const aliceTokens = await balanceOf(token, alice.address);
  await send(alice, 'sell', [1n, aliceTokens / 2n, 0n]);
  await sync();
  const afterSell = await pricesMatch('after the sell');
  check('the sell is indexed', afterSell.trades === 4, afterSell.trades);
  const sells = ((await api(`/api/coins/${coin.id}/trades`)).json.trades as any[]).filter((t) => t.side === 'sell');
  check('the sell row belongs to alice', sells.length === 1 && JSON.stringify(sells[0]).toLowerCase().includes(alice.address.toLowerCase()) && sells[0].quote > 0, sells);
  const holdersNow = (await api(`/api/coins/${coin.id}/holders`)).json.holders as any[];
  const aliceRow = holdersNow.find((h) => h.address?.toLowerCase() === alice.address.toLowerCase());
  check('alice\'s holding follows her on-chain balance', !!aliceRow && Math.abs(aliceRow.amount * 1e6 - Number(await balanceOf(token, alice.address))) < 2, aliceRow);

  console.log('a coin bought inside its first seconds pays the launch surcharge');
  await send(creator, 'createCoin', [{ name: 'Second Coin', symbol: 'TWO', metadataURI: '', firstBuy: 0n }]);
  await send(alice, 'buy', [2n, 0n], parseEther('1')); // a second or so after launch: about 20% surcharge on top of the 1% fee
  await sync();
  const early = (await api('/api/coins/hyp-99901-2/trades')).json.trades?.[0];
  // a fresh pool holds 1e9 tokens against a ~35.65 HYPE virtual reserve: 1 HYPE at 1% fee buys ~27.0M tokens, at ~21% fee ~21.7M
  check('the early buyer received about 21.7M tokens (fee ~21%), not the 27.0M a late buyer gets', early && early.tokens > 21_400_000 && early.tokens < 22_400_000, early?.tokens);

  console.log('AntiVamp');
  let dup = false;
  try {
    await send(bob, 'createCoin', [{ name: 'chain TEST coin', symbol: 'ctc', metadataURI: '', firstBuy: 0n }]);
  } catch {
    dup = true;
  }
  check('a duplicate name + ticker is rejected on-chain, in any case', dup);

  console.log('fees: collect, split, claim');
  await send(bob, 'collectFees', [1n]); // anyone may trigger it
  const collected = (await pub.readContract({ address: PAD, abi: launchpadAbi, functionName: 'coinInfo', args: [1n] })) as any;
  check('the creator got half of the native fees', collected.creatorNative > 0n, collected.creatorNative);
  const protocolNative = (await pub.readContract({ address: PAD, abi: launchpadAbi, functionName: 'protocolNative' })) as bigint;
  check('the protocol got the other half (to within a wei)', protocolNative >= collected.creatorNative - 1n);
  const before = await pub.getBalance({ address: creator.address });
  await send(creator, 'claim', [1n]);
  check('the creator was paid', (await pub.getBalance({ address: creator.address })) > before - parseEther('0.01') + collected.creatorNative / 2n);
  let outsider = false;
  try {
    await send(alice, 'claim', [1n]);
  } catch {
    outsider = true;
  }
  check('only the creator can claim', outsider);
  const afterClaim = (await pub.readContract({ address: PAD, abi: launchpadAbi, functionName: 'coinInfo', args: [1n] })) as any;
  check("the creator's unclaimed balance is zero on-chain after the claim", afterClaim.creatorNative === 0n && afterClaim.creatorToken === 0n, afterClaim);
  await sync();

  console.log('every token accounted for');
  const total = (await pub.readContract({ address: token, abi: tokenAbi, functionName: 'totalSupply' })) as bigint;
  let sum = 0n;
  for (const who of [POOL_MANAGER, PAD, creator.address, alice.address, bob.address]) sum += await balanceOf(token, who as `0x${string}`);
  check('pool + launchpad + wallets == total supply', sum === total, { sum, total });
  const feesInPad = await balanceOf(token, PAD);
  check('the pool still holds nearly the whole supply', (await balanceOf(token, POOL_MANAGER as `0x${string}`)) > (total * 90n) / 100n, feesInPad);

  console.log('comments with an EVM identity');
  const cm = await api(`/api/coins/${coin.id}/comments`, { token: cs.token, body: { text: 'gm from the creator wallet' } });
  check('EVM-signed session can post to the thread', cm.status === 200 && cm.json.comments?.[0]?.user === getAddress(creator.address), cm.json);

  console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nAll on-chain checks passed\n');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
