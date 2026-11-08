/**
 * pump.fun integration: quotes, instruction builders and transaction assembly for launching and trading on
 * pump.fun's REAL on-chain program (mainnet-beta). Transactions are built here in the browser and signed by the
 * user's own wallet; no server ever sees keys or crafts what the wallet signs.
 *
 * Layouts/PDAs live in ./pumpLayout and are verified against the IDL and real mainnet data in tests/pump.test.ts.
 */
import { Buffer } from 'buffer';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type SimulatedTransactionResponse,
} from '@solana/web3.js';
import {
  ATA_PROGRAM,
  DISC,
  FEE_PROGRAM,
  MAYHEM_PROGRAM,
  PUMP_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  ata,
  decodeBondingCurve,
  decodeFeeConfig,
  decodeGlobal,
  isSolQuoted,
  pumpPdas,
  UNSUPPORTED_QUOTE_MESSAGE,
  type BondingCurve,
  type PumpFeeConfig,
  type PumpGlobal,
} from './pumpLayout';

export { isSolQuoted, UNSUPPORTED_QUOTE_MESSAGE };

export const LAMPORTS = 1_000_000_000n;

/**
 * The address lookup table that pump.fun's own create+buy transactions use (observed on mainnet). It only lets a
 * transaction refer to well-known accounts by index to stay under Solana's 1232-byte limit; it cannot change what
 * any address is, so using it is purely a size optimisation.
 */
export const PUMP_LOOKUP_TABLE = new PublicKey('Hyif6eWb8x88RVrvjPfabsgRYnwkVnyByEXTVTXbUcyP');
export const MAX_TX_BYTES = 1232;

export async function loadLookupTable(conn: Connection): Promise<AddressLookupTableAccount | null> {
  try {
    return (await conn.getAddressLookupTable(PUMP_LOOKUP_TABLE)).value;
  } catch {
    return null;
  }
}
/** pump.fun tokens have 6 decimals. */
export const TOKEN_DECIMALS = 6;

/* ------------------------------------------------------------------ fees */

export interface FeeRates {
  protocolBps: bigint;
  creatorBps: bigint;
}

/** Market cap in lamports used to pick a fee tier: virtual SOL * supply / virtual tokens. */
export function marketCapLamports(c: Pick<BondingCurve, 'virtualQuoteReserves' | 'virtualTokenReserves' | 'tokenTotalSupply'>): bigint {
  return c.virtualTokenReserves === 0n ? 0n : (c.virtualQuoteReserves * c.tokenTotalSupply) / c.virtualTokenReserves;
}

/**
 * Fee rates for a curve. Protocol fee comes from the fee tier that matches the market cap; the creator fee is the
 * curve's own rate when it has one (creators can configure it) and the tier's otherwise. Verified against real
 * TradeEvents (0.95% + 0.30%). Quotes are estimates: the program enforces the slippage bounds we pass.
 */
export function feeRatesFor(curve: BondingCurve, feeConfig: PumpFeeConfig): FeeRates {
  const mcap = marketCapLamports(curve);
  let fees = feeConfig.flatFees;
  for (const t of feeConfig.tiers) if (mcap >= t.marketCapLamportsThreshold) fees = t.fees;
  const hasCreator = !curve.creator.equals(SYSTEM_PROGRAM);
  return {
    protocolBps: fees.protocolFeeBps,
    creatorBps: hasCreator ? (curve.creatorFeeBps > 0n ? curve.creatorFeeBps : fees.creatorFeeBps) : 0n,
  };
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/* ---------------------------------------------------------------- quotes */

export interface BuyQuote {
  tokensOut: bigint;
  /** SOL that goes into the curve (after fees), lamports */
  netSol: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  /** price impact in percent */
  impactPct: number;
  /** true when the buy would exhaust the curve's remaining tokens */
  capped: boolean;
}

/**
 * "Spend exactly S lamports" quote, pump.fun's documented formula for `buy_exact_sol_in`
 * (and verified against real exact-spend trades):
 *   net  = floor(S * 10_000 / (10_000 + totalFeeBps)), reduced if net + fees would exceed S
 *   out  = floor((net - 1) * vt / (vs + net - 1))
 */
export function quoteBuyExactSol(curve: BondingCurve, fees: FeeRates, spendable: bigint): BuyQuote {
  const total = fees.protocolBps + fees.creatorBps;
  let net = (spendable * 10_000n) / (10_000n + total);
  const f = (n: bigint) => ceilDiv(n * fees.protocolBps, 10_000n) + ceilDiv(n * fees.creatorBps, 10_000n);
  const over = net + f(net) - spendable;
  if (over > 0n) net -= over;
  if (net <= 1n) return { tokensOut: 0n, netSol: 0n, protocolFee: 0n, creatorFee: 0n, impactPct: 0, capped: false };
  let tokensOut = ((net - 1n) * curve.virtualTokenReserves) / (curve.virtualQuoteReserves + net - 1n);
  const capped = tokensOut > curve.realTokenReserves;
  if (capped) tokensOut = curve.realTokenReserves;
  const before = Number(curve.virtualQuoteReserves) / Number(curve.virtualTokenReserves);
  const after = Number(curve.virtualQuoteReserves + net) / Number(curve.virtualTokenReserves - tokensOut || 1n);
  return {
    tokensOut,
    netSol: net,
    protocolFee: ceilDiv(net * fees.protocolBps, 10_000n),
    creatorFee: ceilDiv(net * fees.creatorBps, 10_000n),
    impactPct: before > 0 ? Math.max(0, (after / before - 1) * 100) : 0,
    capped,
  };
}

export interface SellQuote {
  grossSol: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  /** what lands in the seller's wallet */
  netSol: bigint;
  impactPct: number;
}

/** Selling T tokens: gross = floor(T * vs / (vt + T)); fees are taken out of the gross amount. */
export function quoteSell(curve: BondingCurve, fees: FeeRates, tokens: bigint): SellQuote {
  const gross = (tokens * curve.virtualQuoteReserves) / (curve.virtualTokenReserves + tokens);
  const protocolFee = ceilDiv(gross * fees.protocolBps, 10_000n);
  const creatorFee = ceilDiv(gross * fees.creatorBps, 10_000n);
  const before = Number(curve.virtualQuoteReserves) / Number(curve.virtualTokenReserves);
  const after = Number(curve.virtualQuoteReserves - gross) / Number(curve.virtualTokenReserves + tokens);
  return {
    grossSol: gross,
    protocolFee,
    creatorFee,
    netSol: gross > protocolFee + creatorFee ? gross - protocolFee - creatorFee : 0n,
    impactPct: before > 0 ? Math.max(0, (1 - after / before) * 100) : 0,
  };
}

/** Initial curve state of a brand-new coin, from the Global account. */
export function initialCurve(g: PumpGlobal, creator: PublicKey): BondingCurve {
  return {
    virtualTokenReserves: g.initialVirtualTokenReserves,
    virtualQuoteReserves: g.initialVirtualSolReserves,
    realTokenReserves: g.initialRealTokenReserves,
    realQuoteReserves: 0n,
    tokenTotalSupply: g.tokenTotalSupply,
    complete: false,
    creator,
    isMayhemMode: false,
    isCashbackCoin: false,
    quoteMint: SYSTEM_PROGRAM,
    creatorFeeBps: 0n,
    isHolderReward: false,
  };
}

/** Apply a slippage tolerance (bps) to an expected output. */
export const minAfterSlippage = (expected: bigint, slippageBps: number) => (expected * BigInt(10_000 - slippageBps)) / 10_000n;

/* ------------------------------------------------------ account fetching */

export interface PumpContext {
  global: PumpGlobal;
  feeConfig: PumpFeeConfig;
}

async function getAccount(conn: Connection, key: PublicKey, what: string) {
  const info = await conn.getAccountInfo(key, 'confirmed');
  if (!info) throw new Error(`${what} account not found. Is this the Solana mainnet RPC?`);
  return info;
}

/** The two config accounts every pump.fun transaction depends on. */
export async function loadPumpContext(conn: Connection): Promise<PumpContext> {
  const [g, f] = await Promise.all([
    getAccount(conn, pumpPdas.global(), 'pump.fun Global'),
    getAccount(conn, pumpPdas.feeConfig(), 'pump.fun fee config'),
  ]);
  return { global: decodeGlobal(g.data), feeConfig: decodeFeeConfig(f.data) };
}

export interface CurveInfo {
  mint: PublicKey;
  curve: BondingCurve;
  tokenProgram: PublicKey;
}

/** Bonding curve state + which token program owns the mint (SPL Token or Token-2022). */
export async function loadCurve(conn: Connection, mint: PublicKey): Promise<CurveInfo> {
  const [bc, mintAcct] = await Promise.all([
    conn.getAccountInfo(pumpPdas.bondingCurve(mint), 'confirmed'),
    conn.getAccountInfo(mint, 'confirmed'),
  ]);
  if (!bc) throw new Error('This coin has no pump.fun bonding curve');
  if (!mintAcct) throw new Error('Mint account not found');
  return { mint, curve: decodeBondingCurve(bc.data), tokenProgram: mintAcct.owner };
}

export async function tokenBalance(conn: Connection, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): Promise<bigint> {
  try {
    const r = await conn.getTokenAccountBalance(ata(owner, mint, tokenProgram), 'confirmed');
    return BigInt(r.value.amount);
  } catch {
    return 0n; // no token account yet
  }
}

/** Any of the 8 buyback recipients is valid; real clients pick one at random. */
export function pickBuybackRecipient(g: PumpGlobal): PublicKey {
  const all = g.buybackFeeRecipients.filter((k) => !k.equals(SYSTEM_PROGRAM));
  if (!all.length) throw new Error('pump.fun has no buyback fee recipients configured');
  return all[Math.floor(Math.random() * all.length)];
}

/** Which fee recipient to pass: mayhem coins must use the reserved ones. */
export function pickFeeRecipient(g: PumpGlobal, mayhem: boolean): PublicKey {
  if (mayhem) return g.reservedFeeRecipient;
  // spreading load across the allowed recipients is what pump.fun's own UI does; any of them is valid
  const all = [g.feeRecipient, ...g.feeRecipients].filter((k) => !k.equals(SYSTEM_PROGRAM));
  return all[Math.floor(Math.random() * all.length)];
}

/* ------------------------------------------------------- instruction data */

const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const borshString = (s: string) => {
  const body = Buffer.from(new TextEncoder().encode(s));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length);
  return Buffer.concat([len, body]);
};
const flag = (v: boolean) => Buffer.from([v ? 1 : 0]);
const disc = (d: readonly number[]) => Buffer.from(d);

export interface CreateArgs {
  name: string;
  symbol: string;
  uri: string;
  creator: PublicKey;
  /** share trading fees with holders (pump.fun's native holder rewards). Requires Global.isHolderRewardEnabled. */
  holderRewards?: boolean;
}

/** Borsh data for `create_v2` (all optional trailing args encoded as their default: off / unset). */
export function createV2Data(a: CreateArgs): Buffer {
  return Buffer.concat([
    disc(DISC.createV2),
    borshString(a.name),
    borshString(a.symbol),
    borshString(a.uri),
    a.creator.toBuffer(),
    flag(false), // is_mayhem_mode
    flag(false), // is_cashback_enabled: OptionBool
    u64le(0n), // creator_fee_bps: OptionU64 (0 = protocol default)
    flag(!!a.holderRewards), // is_holder_reward: OptionBool
  ]);
}

export function buyExactSolInData(spendable: bigint, minTokensOut: bigint): Buffer {
  return Buffer.concat([disc(DISC.buyExactSolIn), u64le(spendable), u64le(minTokensOut), flag(false), flag(false)]);
}

export function sellData(tokens: bigint, minSolOut: bigint): Buffer {
  return Buffer.concat([disc(DISC.sell), u64le(tokens), u64le(minSolOut)]);
}

/* ------------------------------------------------------------ instructions */

type Meta = { pubkey: PublicKey; isSigner: boolean; isWritable: boolean };
const m = (pubkey: PublicKey, isWritable = false, isSigner = false): Meta => ({ pubkey, isSigner, isWritable });

/** `create_v2`: a Token-2022 coin with a bonding curve. The mint keypair must also sign the transaction. */
export function ixCreateV2(user: PublicKey, mint: PublicKey, a: CreateArgs): TransactionInstruction {
  const bondingCurve = pumpPdas.bondingCurve(mint);
  const solVault = pumpPdas.mayhemSolVault();
  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
      m(mint, true, true),
      m(pumpPdas.mintAuthority()),
      m(bondingCurve, true),
      m(ata(bondingCurve, mint, TOKEN_2022_PROGRAM), true),
      m(pumpPdas.global()),
      m(user, true, true),
      m(SYSTEM_PROGRAM),
      m(TOKEN_2022_PROGRAM),
      m(ATA_PROGRAM),
      m(MAYHEM_PROGRAM, true),
      m(pumpPdas.mayhemGlobalParams()),
      m(solVault, true),
      m(pumpPdas.mayhemState(mint), true),
      m(ata(solVault, mint, TOKEN_2022_PROGRAM), true),
      m(pumpPdas.eventAuthority()),
      m(PUMP_PROGRAM),
    ],
    data: createV2Data(a),
  });
}

/** Idempotent associated-token-account creation (no-op if it already exists). */
export function ixCreateAtaIdempotent(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [m(payer, true, true), m(ata(owner, mint, tokenProgram), true), m(owner), m(mint), m(SYSTEM_PROGRAM), m(tokenProgram)],
    data: Buffer.from([1]), // CreateIdempotent
  });
}

interface TradeAccounts {
  user: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  tokenProgram: PublicKey;
  feeRecipient: PublicKey;
  /** receives the buyback share of the protocol fee (see pickBuybackRecipient) */
  buybackRecipient: PublicKey;
}

/** Remaining accounts that current pump.fun clients append to buy and sell. */
const remaining = (t: TradeAccounts): Meta[] => [m(pumpPdas.bondingCurveV2(t.mint)), m(t.buybackRecipient, true)];

function buyAccounts(t: TradeAccounts): Meta[] {
  const bondingCurve = pumpPdas.bondingCurve(t.mint);
  return [
    m(pumpPdas.global()),
    m(t.feeRecipient, true),
    m(t.mint),
    m(bondingCurve, true),
    m(ata(bondingCurve, t.mint, t.tokenProgram), true),
    m(ata(t.user, t.mint, t.tokenProgram), true),
    m(t.user, true, true),
    m(SYSTEM_PROGRAM),
    m(t.tokenProgram),
    m(pumpPdas.creatorVault(t.creator), true),
    m(pumpPdas.eventAuthority()),
    m(PUMP_PROGRAM),
    m(pumpPdas.globalVolumeAccumulator()),
    m(pumpPdas.userVolumeAccumulator(t.user), true),
    m(pumpPdas.feeConfig()),
    m(FEE_PROGRAM),
    ...remaining(t),
  ];
}

function sellAccounts(t: TradeAccounts): Meta[] {
  const bondingCurve = pumpPdas.bondingCurve(t.mint);
  return [
    m(pumpPdas.global()),
    m(t.feeRecipient, true),
    m(t.mint),
    m(bondingCurve, true),
    m(ata(bondingCurve, t.mint, t.tokenProgram), true),
    m(ata(t.user, t.mint, t.tokenProgram), true),
    m(t.user, true, true),
    m(SYSTEM_PROGRAM),
    m(pumpPdas.creatorVault(t.creator), true),
    m(t.tokenProgram),
    m(pumpPdas.eventAuthority()),
    m(PUMP_PROGRAM),
    m(pumpPdas.feeConfig()),
    m(FEE_PROGRAM),
    ...remaining(t),
  ];
}

export const ixBuyExactSolIn = (t: TradeAccounts, spendable: bigint, minTokensOut: bigint) =>
  new TransactionInstruction({ programId: PUMP_PROGRAM, keys: buyAccounts(t), data: buyExactSolInData(spendable, minTokensOut) });

export const ixSell = (t: TradeAccounts, tokens: bigint, minSolOut: bigint) =>
  new TransactionInstruction({ programId: PUMP_PROGRAM, keys: sellAccounts(t), data: sellData(tokens, minSolOut) });

/**
 * `collect_creator_fee`: moves a creator's accumulated trading fees from their creator vault to their wallet.
 * The vault is keyed by the creator WALLET, so one claim collects the fees of all of that wallet's pump.fun coins.
 */
export function ixCollectCreatorFee(creator: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [m(creator, true), m(pumpPdas.creatorVault(creator), true), m(SYSTEM_PROGRAM), m(pumpPdas.eventAuthority()), m(PUMP_PROGRAM)],
    data: disc(DISC.collectCreatorFee),
  });
}

/** Lamports a creator could collect right now (vault balance above its rent-exempt minimum). */
export async function creatorVaultClaimable(conn: Connection, creator: PublicKey): Promise<bigint> {
  const vault = pumpPdas.creatorVault(creator);
  const [bal, rent] = await Promise.all([conn.getBalance(vault, 'confirmed'), conn.getMinimumBalanceForRentExemption(0)]);
  return BigInt(Math.max(0, bal - rent));
}

export async function prepareCollectCreatorFee(conn: Connection, payer: PublicKey, creator: PublicKey): Promise<VersionedTransaction> {
  return assemble(conn, payer, [ixCollectCreatorFee(creator)], { computeUnitLimit: 100_000, microLamportsPerUnit: 100_000 });
}

/* ---------------------------------------------------- transaction assembly */

export interface PriorityFee {
  computeUnitLimit: number;
  microLamportsPerUnit: number;
}
export const DEFAULT_PRIORITY: PriorityFee = { computeUnitLimit: 300_000, microLamportsPerUnit: 100_000 };

export async function assemble(
  conn: Connection,
  payer: PublicKey,
  instructions: TransactionInstruction[],
  priority: PriorityFee = DEFAULT_PRIORITY,
  lookupTables: AddressLookupTableAccount[] = [],
): Promise<VersionedTransaction> {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: priority.computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority.microLamportsPerUnit }),
      ...instructions,
    ],
  }).compileToV0Message(lookupTables);
  return new VersionedTransaction(msg);
}

export interface PreparedCreate {
  tx: VersionedTransaction;
  mint: Keypair;
  expectedTokens: bigint;
}

/**
 * Create a coin and (optionally) make the creator's first buy in the SAME transaction, like pump.fun's own UI.
 * The returned transaction is already signed by the fresh mint keypair; the user's wallet adds its signature.
 */
export async function prepareCreate(
  conn: Connection,
  ctx: PumpContext,
  user: PublicKey,
  args: Omit<CreateArgs, 'creator'>,
  firstBuyLamports: bigint,
  slippageBps = 1000,
): Promise<PreparedCreate> {
  if (!ctx.global.createV2Enabled) throw new Error('pump.fun has coin creation switched off right now');
  if (args.holderRewards && !ctx.global.isHolderRewardEnabled) throw new Error('pump.fun holder rewards are not enabled right now');
  const mint = Keypair.generate();
  const ixs: TransactionInstruction[] = [ixCreateV2(user, mint.publicKey, { ...args, creator: user })];
  let expectedTokens = 0n;
  if (firstBuyLamports > 0n) {
    const curve = initialCurve(ctx.global, user);
    const rates = feeRatesFor(curve, ctx.feeConfig);
    const q = quoteBuyExactSol(curve, rates, firstBuyLamports);
    if (q.tokensOut <= 0n) throw new Error('First buy is too small');
    expectedTokens = q.tokensOut;
    ixs.push(ixCreateAtaIdempotent(user, user, mint.publicKey, TOKEN_2022_PROGRAM));
    ixs.push(
      ixBuyExactSolIn(
        { user, mint: mint.publicKey, creator: user, tokenProgram: TOKEN_2022_PROGRAM, feeRecipient: pickFeeRecipient(ctx.global, false), buybackRecipient: pickBuybackRecipient(ctx.global) },
        firstBuyLamports,
        minAfterSlippage(q.tokensOut, slippageBps),
      ),
    );
  }
  const alt = firstBuyLamports > 0n ? await loadLookupTable(conn) : null;
  const tx = await assemble(conn, user, ixs, { computeUnitLimit: 400_000, microLamportsPerUnit: 100_000 }, alt ? [alt] : []);
  tx.sign([mint]);
  // 1 signature slot is empty until the wallet signs; account for it when checking the size limit
  const size = tx.serialize().length;
  if (size > MAX_TX_BYTES) {
    throw new Error('Create + first buy does not fit in one transaction right now. Launch without a first buy, then buy from the coin page.');
  }
  return { tx, mint, expectedTokens };
}

export async function prepareBuy(
  conn: Connection,
  ctx: PumpContext,
  info: CurveInfo,
  user: PublicKey,
  spendableLamports: bigint,
  slippageBps: number,
): Promise<{ tx: VersionedTransaction; quote: BuyQuote }> {
  if (!isSolQuoted(info.curve.quoteMint)) throw new Error(UNSUPPORTED_QUOTE_MESSAGE);
  if (info.curve.complete) throw new Error('This coin has graduated off the bonding curve. Trade it on its AMM pool.');
  const rates = feeRatesFor(info.curve, ctx.feeConfig);
  const quote = quoteBuyExactSol(info.curve, rates, spendableLamports);
  if (quote.tokensOut <= 0n) throw new Error('Amount too small');
  const ixs = [
    ixCreateAtaIdempotent(user, user, info.mint, info.tokenProgram),
    ixBuyExactSolIn(
      { user, mint: info.mint, creator: info.curve.creator, tokenProgram: info.tokenProgram, feeRecipient: pickFeeRecipient(ctx.global, info.curve.isMayhemMode), buybackRecipient: pickBuybackRecipient(ctx.global) },
      spendableLamports,
      minAfterSlippage(quote.tokensOut, slippageBps),
    ),
  ];
  return { tx: await assemble(conn, user, ixs), quote };
}

export async function prepareSell(
  conn: Connection,
  ctx: PumpContext,
  info: CurveInfo,
  user: PublicKey,
  tokens: bigint,
  slippageBps: number,
): Promise<{ tx: VersionedTransaction; quote: SellQuote }> {
  if (!isSolQuoted(info.curve.quoteMint)) throw new Error(UNSUPPORTED_QUOTE_MESSAGE);
  if (info.curve.complete) throw new Error('This coin has graduated off the bonding curve. Trade it on its AMM pool.');
  const rates = feeRatesFor(info.curve, ctx.feeConfig);
  const quote = quoteSell(info.curve, rates, tokens);
  if (quote.netSol <= 0n) throw new Error('Amount too small');
  const ixs = [
    ixSell(
      { user, mint: info.mint, creator: info.curve.creator, tokenProgram: info.tokenProgram, feeRecipient: pickFeeRecipient(ctx.global, info.curve.isMayhemMode), buybackRecipient: pickBuybackRecipient(ctx.global) },
      tokens,
      minAfterSlippage(quote.netSol, slippageBps),
    ),
  ];
  return { tx: await assemble(conn, user, ixs), quote };
}

/* ------------------------------------------------------- simulate and send */

export interface SimResult {
  ok: boolean;
  error: string | null;
  logs: string[];
  unitsConsumed: number | null;
}

/** Dry-run a transaction against the live program without signatures or fees. Nothing is broadcast. */
export async function simulate(conn: Connection, tx: VersionedTransaction): Promise<SimResult> {
  const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
  const v: SimulatedTransactionResponse = r.value;
  return { ok: !v.err, error: v.err ? JSON.stringify(v.err) : null, logs: v.logs ?? [], unitsConsumed: v.unitsConsumed ?? null };
}

/** Turn the program's raw simulation/send failures into something a person can act on. */
export function friendlyPumpError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/User rejected|rejected the request|declined|Transaction cancelled/i.test(msg)) return 'Transaction was rejected in your wallet';
  if (/insufficient lamports|insufficient funds|0x1\b|Attempt to debit/i.test(msg)) return 'Not enough SOL to cover the amount plus fees and rent';
  if (/TooMuchSolRequired|0x1772|6002/.test(msg)) return 'Price moved beyond your slippage tolerance. Try again.';
  if (/TooLittleSolReceived|0x1773|6003/.test(msg)) return 'Price moved beyond your slippage tolerance. Try again.';
  if (/BondingCurveComplete|0x1775|6005/.test(msg)) return 'This coin has graduated off the bonding curve';
  if (/blockhash not found|block height exceeded|expired/i.test(msg)) return 'The transaction expired before it was confirmed. Please try again.';
  return msg.length > 160 ? msg.slice(0, 160) + '…' : msg;
}

export async function confirm(conn: Connection, signature: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const st = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (st?.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for confirmation. Check your wallet for the result.');
    await new Promise((r) => setTimeout(r, 1200));
  }
}
