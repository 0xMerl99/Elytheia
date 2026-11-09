/**
 * pump.fun on-chain layouts: constants, PDA derivation and binary decoders.
 * Everything here is derived from pump.fun's published IDL (https://github.com/pump-fun/pump-public-docs) and is
 * verified in tests against the IDL file and real mainnet accounts/events captured in tests/fixtures.
 *
 * Pure and synchronous (no network, no wallet) so it is trivially testable and works in browser and Node.
 */
import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';

export const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
export const MAYHEM_PROGRAM = new PublicKey('MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e');
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');

/** 8-byte Anchor discriminators (from the IDL; asserted against sha256("global:<name>") in the tests). */
export const DISC = {
  createV2: [214, 144, 76, 236, 95, 139, 49, 180],
  buy: [102, 6, 61, 18, 1, 218, 235, 234],
  buyExactSolIn: [56, 252, 116, 8, 158, 223, 205, 95],
  sell: [51, 230, 133, 164, 1, 127, 131, 173],
  collectCreatorFee: [20, 22, 86, 123, 198, 28, 219, 132],
  accounts: {
    bondingCurve: [23, 183, 248, 55, 96, 216, 172, 96],
    global: [167, 232, 232, 177, 200, 108, 114, 127],
    feeConfig: [143, 52, 146, 187, 219, 123, 76, 155],
  },
  events: {
    trade: [189, 219, 127, 211, 78, 230, 97, 238],
    create: [27, 114, 169, 77, 222, 235, 99, 118],
  },
} as const;

/** Anchor event-CPI marker: instruction data starts with these 8 bytes, then the event discriminator. */
export const EVENT_IX_TAG = Uint8Array.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

const te = new TextEncoder();
const find = (seeds: (Uint8Array | Buffer)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

/* --------------------------------------------------------------------- PDAs */

export const pumpPdas = {
  global: () => find([te.encode('global')], PUMP_PROGRAM),
  mintAuthority: () => find([te.encode('mint-authority')], PUMP_PROGRAM),
  eventAuthority: () => find([te.encode('__event_authority')], PUMP_PROGRAM),
  bondingCurve: (mint: PublicKey) => find([te.encode('bonding-curve'), mint.toBytes()], PUMP_PROGRAM),
  /** passed (read-only) as a remaining account on every trade; verified against real mainnet trades */
  bondingCurveV2: (mint: PublicKey) => find([te.encode('bonding-curve-v2'), mint.toBytes()], PUMP_PROGRAM),
  creatorVault: (creator: PublicKey) => find([te.encode('creator-vault'), creator.toBytes()], PUMP_PROGRAM),
  globalVolumeAccumulator: () => find([te.encode('global_volume_accumulator')], PUMP_PROGRAM),
  userVolumeAccumulator: (user: PublicKey) => find([te.encode('user_volume_accumulator'), user.toBytes()], PUMP_PROGRAM),
  feeConfig: () => find([te.encode('fee_config'), PUMP_PROGRAM.toBytes()], FEE_PROGRAM),
  // mayhem program accounts required by create_v2
  mayhemGlobalParams: () => find([te.encode('global-params')], MAYHEM_PROGRAM),
  mayhemSolVault: () => find([te.encode('sol-vault')], MAYHEM_PROGRAM),
  mayhemState: (mint: PublicKey) => find([te.encode('mayhem-state'), mint.toBytes()], MAYHEM_PROGRAM),
};

/** Associated token account address (no network). */
export function ata(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return find([owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], ATA_PROGRAM);
}

/* ------------------------------------------------------------------ reader */

export class Reader {
  private o: number;
  private v: DataView;
  constructor(public buf: Uint8Array, offset = 0) {
    this.o = offset;
    this.v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get offset() {
    return this.o;
  }
  get remaining() {
    return this.buf.length - this.o;
  }
  skip(n: number) {
    this.o += n;
  }
  u8() {
    return this.v.getUint8(this.o++);
  }
  bool() {
    return this.u8() !== 0;
  }
  u32() {
    const x = this.v.getUint32(this.o, true);
    this.o += 4;
    return x;
  }
  u64() {
    const x = this.v.getBigUint64(this.o, true);
    this.o += 8;
    return x;
  }
  i64() {
    const x = this.v.getBigInt64(this.o, true);
    this.o += 8;
    return x;
  }
  u128() {
    const lo = this.v.getBigUint64(this.o, true);
    const hi = this.v.getBigUint64(this.o + 8, true);
    this.o += 16;
    return (hi << 64n) | lo;
  }
  pk() {
    const k = new PublicKey(this.buf.subarray(this.o, this.o + 32));
    this.o += 32;
    return k;
  }
  str() {
    const n = this.u32();
    const s = new TextDecoder().decode(this.buf.subarray(this.o, this.o + n));
    this.o += n;
    return s;
  }
}

const startsWith = (buf: Uint8Array, prefix: readonly number[]) => prefix.every((b, i) => buf[i] === b);

/**
 * pump.fun coins can be quoted in SOL or in another token (`quote_mint`). SOL-quoted curves carry the zero key
 * (the system program id). Anything else prices in a different asset, so SOL maths and labels would be WRONG for it.
 */
export const isSolQuoted = (quoteMint: PublicKey) => quoteMint.equals(SYSTEM_PROGRAM);

export const UNSUPPORTED_QUOTE_MESSAGE =
  "This token is priced in another token, not SOL, which ELYONPAD doesn't support yet. You can trade it on pump.fun.";

/* ----------------------------------------------------------- BondingCurve */

export interface BondingCurve {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: PublicKey;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  /** all-zero / system program for SOL-quoted curves */
  quoteMint: PublicKey;
  creatorFeeBps: bigint;
  isHolderReward: boolean;
}

/**
 * Old curves were created before later fields existed and are shorter (81 bytes), so everything after `creator`
 * is read only if present.
 */
export function decodeBondingCurve(data: Uint8Array): BondingCurve {
  if (!startsWith(data, DISC.accounts.bondingCurve)) throw new Error('Not a pump.fun bonding curve account');
  const r = new Reader(data, 8);
  const c: BondingCurve = {
    virtualTokenReserves: r.u64(),
    virtualQuoteReserves: r.u64(),
    realTokenReserves: r.u64(),
    realQuoteReserves: r.u64(),
    tokenTotalSupply: r.u64(),
    complete: r.bool(),
    creator: r.pk(),
    isMayhemMode: false,
    isCashbackCoin: false,
    quoteMint: SYSTEM_PROGRAM,
    creatorFeeBps: 0n,
    isHolderReward: false,
  };
  if (r.remaining >= 2) {
    c.isMayhemMode = r.bool();
    c.isCashbackCoin = r.bool();
  }
  if (r.remaining >= 32) c.quoteMint = r.pk();
  if (r.remaining >= 8) c.creatorFeeBps = r.u64();
  if (r.remaining >= 2) {
    r.bool(); // can_edit_creator_fee
    c.isHolderReward = r.bool();
  }
  return c;
}

/* ------------------------------------------------------------------ Global */

export interface PumpGlobal {
  feeRecipient: PublicKey;
  feeRecipients: PublicKey[];
  initialVirtualTokenReserves: bigint;
  initialVirtualSolReserves: bigint;
  initialRealTokenReserves: bigint;
  tokenTotalSupply: bigint;
  feeBasisPoints: bigint;
  creatorFeeBasisPoints: bigint;
  createV2Enabled: boolean;
  reservedFeeRecipient: PublicKey;
  reservedFeeRecipients: PublicKey[];
  mayhemModeEnabled: boolean;
  isCashbackEnabled: boolean;
  isHolderRewardEnabled: boolean;
  creatorFeeConfigurable: boolean;
  maxConfigurableCreatorFeeBps: bigint;
  /** one of these (writable) is passed on every trade; it receives the buyback share of the protocol fee */
  buybackFeeRecipients: PublicKey[];
}

export function decodeGlobal(data: Uint8Array): PumpGlobal {
  if (!startsWith(data, DISC.accounts.global)) throw new Error('Not the pump.fun Global account');
  const r = new Reader(data, 8);
  const pks = (n: number) => Array.from({ length: n }, () => r.pk());
  r.bool(); // initialized
  r.pk(); // authority
  const feeRecipient = r.pk();
  const initialVirtualTokenReserves = r.u64();
  const initialVirtualSolReserves = r.u64();
  const initialRealTokenReserves = r.u64();
  const tokenTotalSupply = r.u64();
  const feeBasisPoints = r.u64();
  r.pk(); // withdraw_authority
  r.bool(); // enable_migrate
  r.u64(); // pool_migration_fee
  const creatorFeeBasisPoints = r.u64();
  const feeRecipients = pks(7);
  r.pk(); // set_creator_authority
  r.pk(); // admin_set_creator_authority
  const createV2Enabled = r.bool();
  r.pk(); // whitelist_pda
  const reservedFeeRecipient = r.pk();
  const mayhemModeEnabled = r.bool();
  const reservedFeeRecipients = pks(7);
  const isCashbackEnabled = r.bool();
  const buybackFeeRecipients = pks(8);
  r.u64(); // buyback_basis_points
  r.u64(); // initial_virtual_quote_reserves
  pks(1); // whitelisted_quote_mints
  const creatorFeeConfigurable = r.bool();
  const maxConfigurableCreatorFeeBps = r.u64();
  r.pk(); // holder_reward_claim_authority
  const isHolderRewardEnabled = r.bool();
  return {
    feeRecipient,
    feeRecipients,
    initialVirtualTokenReserves,
    initialVirtualSolReserves,
    initialRealTokenReserves,
    tokenTotalSupply,
    feeBasisPoints,
    creatorFeeBasisPoints,
    createV2Enabled,
    reservedFeeRecipient,
    reservedFeeRecipients,
    mayhemModeEnabled,
    isCashbackEnabled,
    isHolderRewardEnabled,
    creatorFeeConfigurable,
    maxConfigurableCreatorFeeBps,
    buybackFeeRecipients,
  };
}

/* --------------------------------------------------------------- FeeConfig */

export interface FeeSet {
  lpFeeBps: bigint;
  protocolFeeBps: bigint;
  creatorFeeBps: bigint;
}
export interface FeeTier {
  marketCapLamportsThreshold: bigint;
  fees: FeeSet;
}
export interface PumpFeeConfig {
  flatFees: FeeSet;
  tiers: FeeTier[];
}

export function decodeFeeConfig(data: Uint8Array): PumpFeeConfig {
  if (!startsWith(data, DISC.accounts.feeConfig)) throw new Error('Not the pump.fun fee config account');
  const r = new Reader(data, 8);
  const fees = (): FeeSet => ({ lpFeeBps: r.u64(), protocolFeeBps: r.u64(), creatorFeeBps: r.u64() });
  r.u8(); // bump
  r.pk(); // admin
  const flatFees = fees();
  const n = r.u32();
  const tiers: FeeTier[] = [];
  for (let i = 0; i < n; i++) tiers.push({ marketCapLamportsThreshold: r.u128(), fees: fees() });
  return { flatFees, tiers };
}

/* -------------------------------------------------------------- TradeEvent */

export interface TradeEvent {
  mint: PublicKey;
  solAmount: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  user: PublicKey;
  timestamp: bigint;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  feeRecipient: PublicKey;
  feeBasisPoints: bigint;
  fee: bigint;
  creator: PublicKey;
  creatorFeeBasisPoints: bigint;
  creatorFee: bigint;
}

/** Decodes the leading fixed-size part of a TradeEvent (everything the indexer and tests need). */
export function decodeTradeEvent(body: Uint8Array): TradeEvent {
  const r = new Reader(body);
  return {
    mint: r.pk(),
    solAmount: r.u64(),
    tokenAmount: r.u64(),
    isBuy: r.bool(),
    user: r.pk(),
    timestamp: r.i64(),
    virtualSolReserves: r.u64(),
    virtualTokenReserves: r.u64(),
    realSolReserves: r.u64(),
    realTokenReserves: r.u64(),
    feeRecipient: r.pk(),
    feeBasisPoints: r.u64(),
    fee: r.u64(),
    creator: r.pk(),
    creatorFeeBasisPoints: r.u64(),
    creatorFee: r.u64(),
  };
}

export interface CreateEvent {
  name: string;
  symbol: string;
  uri: string;
  mint: PublicKey;
  bondingCurve: PublicKey;
  user: PublicKey;
  creator: PublicKey;
  timestamp: bigint;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  tokenProgram: PublicKey;
  isMayhemMode: boolean;
  /** the zero key for SOL-quoted coins (events from older program versions never carried it) */
  quoteMint: PublicKey;
  /** pump.fun's native holder-rewards mode (absent on events from older program versions) */
  isHolderReward: boolean;
}

export function decodeCreateEvent(body: Uint8Array): CreateEvent {
  const r = new Reader(body);
  const e: CreateEvent = {
    name: r.str(),
    symbol: r.str(),
    uri: r.str(),
    mint: r.pk(),
    bondingCurve: r.pk(),
    user: r.pk(),
    creator: r.pk(),
    timestamp: r.i64(),
    virtualTokenReserves: r.u64(),
    virtualSolReserves: r.u64(),
    realTokenReserves: r.u64(),
    tokenTotalSupply: r.u64(),
    tokenProgram: r.pk(),
    isMayhemMode: r.bool(),
    quoteMint: SYSTEM_PROGRAM,
    isHolderReward: false,
  };
  // later program versions append: is_cashback_enabled, quote_mint, virtual_quote_reserves, creator_fee_bps, is_holder_reward, depth
  if (r.remaining >= 1 + 32 + 8 + 8 + 1) {
    r.bool(); // is_cashback_enabled
    e.quoteMint = r.pk();
    r.u64(); // virtual_quote_reserves
    r.u64(); // creator_fee_bps
    e.isHolderReward = r.bool();
  }
  return e;
}

/** Splits an event-CPI instruction payload into (event discriminator, body), or null if it isn't one. */
export function parseEventIx(data: Uint8Array): { disc: Uint8Array; body: Uint8Array } | null {
  if (data.length < 16) return null;
  for (let i = 0; i < 8; i++) if (data[i] !== EVENT_IX_TAG[i]) return null;
  return { disc: data.subarray(8, 16), body: data.subarray(16) };
}

export const isDisc = (got: Uint8Array, want: readonly number[]) => want.every((b, i) => got[i] === b);
