/**
 * Browser-side access to the Uniswap v4 launchpad contract through the user's own wallet (any EIP-1193 provider:
 * MetaMask, Rabby, Coinbase Wallet, ...). Everything that moves money is signed by that wallet; this site never
 * holds keys or funds in live mode.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  toHex,
  type Chain,
  type EIP1193Provider,
  type PublicClient,
} from 'viem';
import { launchpadAbi } from '../../shared/launchpadAbi';
import type { EvmConfig } from './types';

declare global {
  interface Window {
    ethereum?: EIP1193Provider & { isMetaMask?: boolean; providers?: EIP1193Provider[] };
  }
}

export function chainFrom(cfg: EvmConfig): Chain {
  return defineChain({
    id: cfg.chainId,
    name: cfg.name,
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    blockExplorers: cfg.explorer ? { default: { name: 'Explorer', url: cfg.explorer } } : undefined,
  });
}

const clients = new Map<string, PublicClient>();
export function publicClientFor(cfg: EvmConfig): PublicClient {
  const key = `${cfg.chainId}:${cfg.rpcUrl}`;
  let c = clients.get(key);
  if (!c) {
    c = createPublicClient({ chain: chainFrom(cfg), transport: http(cfg.rpcUrl) }) as PublicClient;
    clients.set(key, c);
  }
  return c;
}

/** The injected provider. If several wallets are installed, prefer the first that is not Phantom's EVM shim. */
export function injectedProvider(): EIP1193Provider | null {
  const eth = window.ethereum;
  if (!eth) return null;
  if (Array.isArray(eth.providers) && eth.providers.length) return eth.providers[0];
  return eth;
}

export const hasEvmWallet = () => !!injectedProvider();

async function ensureChain(provider: EIP1193Provider, cfg: EvmConfig) {
  const chainIdHex = `0x${cfg.chainId.toString(16)}`;
  const current = (await provider.request({ method: 'eth_chainId' })) as string;
  if (current.toLowerCase() === chainIdHex) return;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] });
  } catch (e: any) {
    // 4902 = the wallet doesn't know this chain yet
    if (e?.code === 4902 || /unrecognized|not added|unknown chain/i.test(String(e?.message))) {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: chainIdHex,
            chainName: cfg.name,
            nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
            rpcUrls: [cfg.rpcUrl],
            blockExplorerUrls: cfg.explorer ? [cfg.explorer] : undefined,
          },
        ],
      });
    } else throw e;
  }
}

export async function connectEvm(cfg: EvmConfig): Promise<`0x${string}`> {
  const provider = injectedProvider();
  if (!provider) throw new Error('No EVM wallet found. Install MetaMask, Rabby or another browser wallet.');
  let accounts: string[];
  try {
    accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
  } catch (e: any) {
    if (e?.code === 4001) throw new Error('Connection request was declined');
    throw e;
  }
  if (!accounts?.[0]) throw new Error('The wallet did not return an account');
  await ensureChain(provider, cfg);
  return getAddress(accounts[0]);
}

function walletFor(cfg: EvmConfig, account: `0x${string}`) {
  const provider = injectedProvider();
  if (!provider) throw new Error('Wallet not available');
  return createWalletClient({ account, chain: chainFrom(cfg), transport: custom(provider) });
}

export async function evmSignMessage(cfg: EvmConfig, account: `0x${string}`, message: string): Promise<`0x${string}`> {
  try {
    return await walletFor(cfg, account).signMessage({ message });
  } catch (e: any) {
    if (e?.code === 4001 || /reject|denied|cancel/i.test(String(e?.shortMessage || e?.message))) throw new Error('Signature request was declined');
    throw e;
  }
}

/* ---------------------------------------------------------------- writes */

export interface CreateArgs {
  name: string;
  symbol: string;
  metadataURI: string;
  firstBuyWei: bigint;
  launchFeeWei: bigint;
}

async function write(
  cfg: EvmConfig,
  account: `0x${string}`,
  fn: 'createCoin' | 'buy' | 'sell' | 'claim',
  args: unknown[],
  value = 0n,
) {
  const provider = injectedProvider();
  if (provider) await ensureChain(provider, cfg); // the user may have switched networks since connecting
  const wallet = walletFor(cfg, account);
  const pub = publicClientFor(cfg);
  try {
    // simulate first: surfaces the contract's custom error (e.g. Slippage) before the wallet prompt
    // (typed loosely: one helper serves four differently-typed contract functions)
    const { request } = await pub.simulateContract({
      account,
      address: cfg.launchpad as `0x${string}`,
      abi: launchpadAbi,
      functionName: fn,
      args,
      value,
    } as any);
    const hash = await wallet.writeContract(request as any);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('Transaction failed on-chain');
    return { hash, receipt };
  } catch (e) {
    throw new Error(friendlyEvmError(e));
  }
}

export async function createCoinTx(cfg: EvmConfig, account: `0x${string}`, a: CreateArgs) {
  return write(
    cfg,
    account,
    'createCoin',
    [{ name: a.name, symbol: a.symbol, metadataURI: a.metadataURI, firstBuy: a.firstBuyWei }],
    a.launchFeeWei + a.firstBuyWei,
  );
}
export const buyTx = (cfg: EvmConfig, account: `0x${string}`, ref: bigint, valueWei: bigint, minTokensOut: bigint) =>
  write(cfg, account, 'buy', [ref, minTokensOut], valueWei);
export const sellTx = (cfg: EvmConfig, account: `0x${string}`, ref: bigint, tokens: bigint, minQuoteOut: bigint) =>
  write(cfg, account, 'sell', [ref, tokens, minQuoteOut]);
export const claimTx = (cfg: EvmConfig, account: `0x${string}`, ref: bigint) => write(cfg, account, 'claim', [ref]);

/* ----------------------------------------------------------------- reads */

const tokenAbi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export async function readNativeBalance(cfg: EvmConfig, address: `0x${string}`): Promise<number> {
  return Number(await publicClientFor(cfg).getBalance({ address })) / 1e18;
}

export async function readTokenBalance(cfg: EvmConfig, token: `0x${string}`, owner: `0x${string}`): Promise<bigint> {
  return (await publicClientFor(cfg).readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [owner] })) as bigint;
}

/** The pool's constant-product equivalent reserves (vq in wei, vt in token units) and current tick. */
export async function readMarketState(cfg: EvmConfig, ref: bigint) {
  const [sqrtPriceX96, tick, vq, vt] = (await publicClientFor(cfg).readContract({
    address: cfg.launchpad as `0x${string}`,
    abi: launchpadAbi,
    functionName: 'marketState',
    args: [ref],
  })) as readonly [bigint, number, bigint, bigint];
  return { sqrtPriceX96, tick, vq, vt };
}

/** Collected (claimable) creator fees for a coin, in wei of the native asset and in the coin's own token units. */
export async function readCreatorFees(cfg: EvmConfig, ref: bigint) {
  const info = (await publicClientFor(cfg).readContract({
    address: cfg.launchpad as `0x${string}`,
    abi: launchpadAbi,
    functionName: 'coinInfo',
    args: [ref],
  })) as { creator: `0x${string}`; creatorNative: bigint; creatorToken: bigint };
  return { creator: info.creator, native: info.creatorNative, token: info.creatorToken };
}

export async function readLaunchFee(cfg: EvmConfig): Promise<bigint> {
  return (await publicClientFor(cfg).readContract({
    address: cfg.launchpad as `0x${string}`,
    abi: launchpadAbi,
    functionName: 'launchFee',
  })) as bigint;
}

/** Same identity hash the contract uses for AntiVamp: keccak(abi.encode(lower(name), lower(symbol))). */
export function identityKey(name: string, symbol: string): `0x${string}` {
  const lower = (s: string) => toHex(new TextEncoder().encode(s.replace(/[A-Z]/g, (c) => c.toLowerCase())));
  return keccak256(encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [lower(name), lower(symbol)]));
}

export async function readIdentityTaken(cfg: EvmConfig, name: string, symbol: string): Promise<boolean> {
  return (await publicClientFor(cfg).readContract({
    address: cfg.launchpad as `0x${string}`,
    abi: launchpadAbi,
    functionName: 'identityTaken',
    args: [identityKey(name, symbol)],
  })) as boolean;
}

/** The new coin's on-chain id, read from the CoinCreated event in a receipt. */
export function coinIdFromReceipt(receipt: { logs: readonly { topics: readonly string[]; address: string; data: string }[] }, pad: string): bigint | null {
  const logs = receipt.logs.filter((l) => l.address.toLowerCase() === pad.toLowerCase());
  const ev = parseEventLogs({ abi: launchpadAbi, logs: logs as any, eventName: 'CoinCreated' })[0] as { args: { id: bigint } } | undefined;
  return ev ? ev.args.id : null;
}

/* ---------------------------------------------------------------- errors */

const REVERT_MESSAGES: Record<string, string> = {
  WrongPayment: 'Payment amount does not match the launch fee plus first buy',
  BadName: 'Name must be 1–32 characters',
  BadSymbol: 'Ticker must be 2–10 letters or numbers',
  BadMetadata: 'Metadata link is too long',
  AntiVamp: 'A coin with this name and ticker already exists',
  UnknownCoin: 'This coin does not exist on-chain',
  AmountTooSmall: 'Amount is too small',
  Slippage: 'Price moved beyond your slippage tolerance. Try again.',
  InsufficientBalance: "You don't hold that many tokens",
  InsufficientLiquidity: 'Not enough liquidity in the pool',
  LaunchBuyTooLarge: 'First buy is capped at 20% of supply',
  PartialFill: 'The pool could not fill the whole order at this size. Try a smaller amount.',
  NotCreator: 'Only the coin creator can claim its fees',
  NothingToClaim: 'No fees to claim yet',
  TransferFailed: 'Transfer failed',
};

export function friendlyEvmError(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = revert?.data?.errorName;
    if (name && REVERT_MESSAGES[name]) return REVERT_MESSAGES[name];
    const code = (e.walk((x: any) => x?.code === 4001) as any)?.code;
    if (code === 4001 || /user rejected|user denied/i.test(e.shortMessage)) return 'Transaction was rejected in your wallet';
    if (/insufficient funds/i.test(e.shortMessage + (e.details ?? ''))) return 'Not enough HYPE to cover the amount plus gas';
    return e.shortMessage || 'Transaction failed';
  }
  const msg = (e as Error)?.message ?? 'Transaction failed';
  return /user rejected|user denied/i.test(msg) ? 'Transaction was rejected in your wallet' : msg;
}
