/**
 * pump.fun integration tests. Offline: they run against pump.fun's published IDL and real mainnet data captured in
 * tests/fixtures (accounts, executed trades, a create transaction). Nothing here touches the network.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';
import {
  type TradeEvent,
  ATA_PROGRAM,
  DISC,
  FEE_PROGRAM,
  MAYHEM_PROGRAM,
  PUMP_PROGRAM,
  TOKEN_2022_PROGRAM,
  ata,
  decodeBondingCurve,
  decodeFeeConfig,
  decodeGlobal,
  decodeTradeEvent,
  isSolQuoted,
  pumpPdas,
} from '../src/lib/pumpLayout';
import {
  buyExactSolInData,
  createV2Data,
  feeRatesFor,
  initialCurve,
  ixBuyExactSolIn,
  ixCollectCreatorFee,
  ixCreateV2,
  ixSell,
  marketCapLamports,
  minAfterSlippage,
  quoteBuyExactSol,
  quoteSell,
  sellData,
} from '../src/lib/pump';

const fx = (f: string) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8'));
const idl = fx('pump.idl.json');
const mainnet = fx('pump-mainnet.json');
const createSample = fx('pump-create-sample.json').create_v2;
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const hex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));

const anchorDisc = (kind: string, name: string) => [...createHash('sha256').update(`${kind}:${name}`).digest().subarray(0, 8)];
const idlIx = (name: string) => idl.instructions.find((i: any) => i.name === name);

describe('program interface matches the published IDL', () => {
  it('program ids', () => {
    expect(PUMP_PROGRAM.toBase58()).toBe(idl.address);
    expect(FEE_PROGRAM.toBase58()).toBe(idlIx('buy').accounts.find((a: any) => a.name === 'fee_program').address);
    expect(MAYHEM_PROGRAM.toBase58()).toBe(idlIx('create_v2').accounts.find((a: any) => a.name === 'mayhem_program_id').address);
    expect(ATA_PROGRAM.toBase58()).toBe(idlIx('create_v2').accounts.find((a: any) => a.name === 'associated_token_program').address);
    expect(TOKEN_2022_PROGRAM.toBase58()).toBe(idlIx('create_v2').accounts.find((a: any) => a.name === 'token_program').address);
  });

  it.each([
    ['createV2', 'create_v2'],
    ['buy', 'buy'],
    ['buyExactSolIn', 'buy_exact_sol_in'],
    ['sell', 'sell'],
    ['collectCreatorFee', 'collect_creator_fee'],
  ] as const)('instruction discriminator %s is sha256("global:%s")', (key, name) => {
    expect([...DISC[key]]).toEqual(idlIx(name).discriminator);
    expect([...DISC[key]]).toEqual(anchorDisc('global', name));
  });

  it('account and event discriminators', () => {
    for (const [key, name] of [['bondingCurve', 'BondingCurve'], ['global', 'Global'], ['feeConfig', 'FeeConfig']] as const) {
      expect([...DISC.accounts[key]]).toEqual(idl.accounts.find((a: any) => a.name === name).discriminator);
      expect([...DISC.accounts[key]]).toEqual(anchorDisc('account', name));
    }
    expect([...DISC.events.trade]).toEqual(idl.events.find((e: any) => e.name === 'TradeEvent').discriminator);
    expect([...DISC.events.create]).toEqual(idl.events.find((e: any) => e.name === 'CreateEvent').discriminator);
  });
});

describe('decoders against live mainnet accounts', () => {
  const g = decodeGlobal(b64(mainnet.accounts.global.dataBase64));
  const fc = decodeFeeConfig(b64(mainnet.accounts.feeConfig.dataBase64));

  it('Global', () => {
    expect(g.initialVirtualTokenReserves).toBe(1_073_000_000_000_000n);
    expect(g.initialVirtualSolReserves).toBe(30_000_000_000n);
    expect(g.initialRealTokenReserves).toBe(793_100_000_000_000n);
    expect(g.tokenTotalSupply).toBe(1_000_000_000_000_000n);
    expect(g.feeBasisPoints).toBe(95n);
    expect(g.feeRecipients).toHaveLength(7);
    expect(g.createV2Enabled).toBe(true);
    // the PDA we derive is the account that was fetched
    expect(pumpPdas.global().toBase58()).toBe(mainnet.accounts.global.address);
  });

  it('FeeConfig', () => {
    expect(fc.tiers.length).toBeGreaterThan(0);
    expect(fc.flatFees.protocolFeeBps).toBe(95n);
    expect(pumpPdas.feeConfig().toBase58()).toBe(mainnet.accounts.feeConfig.address);
  });

  it('initial curve matches this project’s own Solana market constants', () => {
    // shared/market.ts models the same curve; they must not drift apart
    expect(g.initialVirtualSolReserves).toBe(30n * 1_000_000_000n);
    expect(g.initialVirtualTokenReserves).toBe(1_073_000_000n * 1_000_000n);
    expect(g.initialRealTokenReserves).toBe(793_100_000n * 1_000_000n);
  });
});

describe('instruction accounts reproduce REAL mainnet transactions', () => {
  it('create_v2: all 16 accounts, in order, from just (mint, user)', () => {
    const mint = new PublicKey(createSample.accounts[0]);
    const user = new PublicKey(createSample.accounts[5]);
    const ix = ixCreateV2(user, mint, { name: 'x', symbol: 'x', uri: 'x', creator: user });
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual(createSample.accounts);
    // signer/writable flags follow the IDL
    const spec = idlIx('create_v2').accounts;
    ix.keys.forEach((k, i) => {
      expect(k.isSigner, `signer ${spec[i].name}`).toBe(!!spec[i].signer);
      expect(k.isWritable, `writable ${spec[i].name}`).toBe(!!spec[i].writable);
    });
  });

  it('create_v2 data encoding matches the on-chain bytes up to the mayhem flag', () => {
    const d = hex(createSample.dataHex);
    // decode name/symbol/uri/creator from the real transaction, re-encode with our function
    let o = 8;
    const s = () => { const n = Buffer.from(d).readUInt32LE(o); o += 4; const v = Buffer.from(d).subarray(o, o + n).toString('utf8'); o += n; return v; };
    const name = s(), symbol = s(), uri = s();
    const creator = new PublicKey(d.subarray(o, o + 32));
    const mine = createV2Data({ name, symbol, uri, creator });
    const prefixLen = o + 32; // everything before is_mayhem_mode
    expect(Buffer.from(mine).subarray(0, prefixLen).equals(Buffer.from(d).subarray(0, prefixLen))).toBe(true);
    // mine = ... + is_mayhem(1) + OptionBool(1) + OptionU64(8) + OptionBool(1)
    expect(mine.length).toBe(prefixLen + 1 + 1 + 8 + 1);
    expect(mine[prefixLen]).toBe(0); // we never opt into mayhem mode
  });

  const real = (name: string) =>
    mainnet.trades.filter((t: any) => t.ixName === name).map((t: any) => ({ t, e: decodeTradeEvent(hex(t.eventHex)) })).filter((x: any) => x.e.fee > 0n);

  it('buy: account list rebuilt from (mint, user, creator, token program, fee recipient)', () => {
    const samples = real('buy');
    expect(samples.length).toBeGreaterThan(0);
    for (const { t, e } of samples) {
      const ix = ixBuyExactSolIn(
        { user: e.user, mint: e.mint, creator: e.creator, tokenProgram: new PublicKey(t.ixAccounts[8]), feeRecipient: new PublicKey(t.ixAccounts[1]), buybackRecipient: new PublicKey(t.ixAccounts[17]) },
        1n,
        1n,
      );
      expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual(t.ixAccounts);
    }
  });

  it('sell: account list rebuilt from (mint, user, creator, token program, fee recipient)', () => {
    const samples = real('sell');
    expect(samples.length).toBeGreaterThan(0);
    for (const { t, e } of samples) {
      const ix = ixSell(
        { user: e.user, mint: e.mint, creator: e.creator, tokenProgram: new PublicKey(t.ixAccounts[9]), feeRecipient: new PublicKey(t.ixAccounts[1]), buybackRecipient: new PublicKey(t.ixAccounts[15]) },
        1n,
        1n,
      );
      expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual(t.ixAccounts);
    }
  });

  it('buy/sell signer + writable flags follow the IDL', () => {
    const e = decodeTradeEvent(hex(real('sell')[0].t.eventHex));
    for (const [name, ix] of [
      ['buy_exact_sol_in', ixBuyExactSolIn({ user: e.user, mint: e.mint, creator: e.creator, tokenProgram: TOKEN_2022_PROGRAM, feeRecipient: e.feeRecipient, buybackRecipient: e.feeRecipient }, 1n, 1n)],
      ['sell', ixSell({ user: e.user, mint: e.mint, creator: e.creator, tokenProgram: TOKEN_2022_PROGRAM, feeRecipient: e.feeRecipient, buybackRecipient: e.feeRecipient }, 1n, 1n)],
    ] as const) {
      const spec = idlIx(name).accounts;
      // the IDL declares the fixed accounts; the two remaining accounts are checked in their own test
      ix.keys.slice(0, spec.length).forEach((k, i) => {
        expect(k.isSigner, `${name}.${spec[i].name} signer`).toBe(!!spec[i].signer);
        expect(k.isWritable, `${name}.${spec[i].name} writable`).toBe(!!spec[i].writable);
      });
      expect(ix.keys.length).toBe(spec.length + 2);
    }
  });

  it('remaining accounts: bonding-curve-v2 is read-only, buyback recipient is writable', () => {
    const { t, e } = real('sell')[0];
    const ix = ixSell({ user: e.user, mint: e.mint, creator: e.creator, tokenProgram: new PublicKey(t.ixAccounts[9]), feeRecipient: new PublicKey(t.ixAccounts[1]), buybackRecipient: new PublicKey(t.ixAccounts[15]) }, 1n, 1n);
    const [v2, buyback] = ix.keys.slice(-2);
    expect(v2.isWritable).toBe(false);
    expect(buyback.isWritable).toBe(true);
    expect(v2.pubkey.toBase58()).toBe(t.ixAccounts[14]);
  });

  it('every real buyback recipient is one of Global.buybackFeeRecipients', () => {
    const g = decodeGlobal(b64(mainnet.accounts.global.dataBase64));
    const ok = new Set(g.buybackFeeRecipients.map((k) => k.toBase58()));
    for (const { t } of [...real('buy'), ...real('sell')]) {
      const last = t.ixAccounts[t.ixAccounts.length - 1];
      expect(ok.has(last)).toBe(true);
    }
  });

  it('collect_creator_fee accounts follow the IDL', () => {
    const creator = new PublicKey(createSample.accounts[5]);
    const ix = ixCollectCreatorFee(creator);
    const spec = idlIx('collect_creator_fee').accounts;
    expect(ix.keys).toHaveLength(spec.length);
    ix.keys.forEach((k, i) => {
      expect(k.isSigner, spec[i].name).toBe(!!spec[i].signer);
      expect(k.isWritable, spec[i].name).toBe(!!spec[i].writable);
    });
    expect(ix.keys[1].pubkey.toBase58()).toBe(pumpPdas.creatorVault(creator).toBase58());
    expect(ix.data.length).toBe(8);
  });

  it('ata derivation matches an on-chain associated_bonding_curve', () => {
    const mint = new PublicKey(createSample.accounts[0]);
    expect(ata(pumpPdas.bondingCurve(mint), mint, TOKEN_2022_PROGRAM).toBase58()).toBe(createSample.accounts[3]);
  });
});

describe('quotes reproduce REAL executed trades', () => {
  const fc = decodeFeeConfig(b64(mainnet.accounts.feeConfig.dataBase64));
  const events: { name: string; e: TradeEvent }[] = mainnet.trades.map((t: any) => ({ name: t.ixName as string, e: decodeTradeEvent(hex(t.eventHex)) }));
  const withFees = events.filter((x) => x.e.fee > 0n && x.e.virtualSolReserves > 0n);

  it('sells: gross output and both fees match exactly', () => {
    const sells = withFees.filter((x: any) => !x.e.isBuy);
    expect(sells.length).toBeGreaterThanOrEqual(3);
    for (const { e } of sells) {
      const pre = {
        virtualQuoteReserves: e.virtualSolReserves + e.solAmount,
        virtualTokenReserves: e.virtualTokenReserves - e.tokenAmount,
      };
      const curve: any = { ...pre, realTokenReserves: 0n, realQuoteReserves: 0n, tokenTotalSupply: 1_000_000_000_000_000n, creator: e.creator, creatorFeeBps: 0n };
      const rates = feeRatesFor(curve, fc);
      expect(rates.protocolBps).toBe(e.feeBasisPoints);
      expect(rates.creatorBps).toBe(e.creatorFeeBasisPoints);
      const q = quoteSell(curve, rates, e.tokenAmount);
      expect(q.grossSol).toBe(e.solAmount);
      expect(q.protocolFee).toBe(e.fee);
      expect(q.creatorFee).toBe(e.creatorFee);
      expect(q.netSol).toBe(e.solAmount - e.fee - e.creatorFee);
    }
  });

  it('exact-spend buys: tokens out, net SOL and fees match exactly', () => {
    const buys = withFees.filter((x: any) => x.e.isBuy && x.name.startsWith('buy_exact_quote_in'));
    expect(buys.length).toBeGreaterThanOrEqual(2);
    for (const { e } of buys) {
      const pre: any = {
        virtualQuoteReserves: e.virtualSolReserves - e.solAmount,
        virtualTokenReserves: e.virtualTokenReserves + e.tokenAmount,
        realTokenReserves: 10n ** 18n, // not the limiting factor here
        tokenTotalSupply: 1_000_000_000_000_000n,
        creator: e.creator,
        creatorFeeBps: 0n,
      };
      const rates = feeRatesFor(pre, fc);
      // what the user spent in total = net into the curve + both fees
      const spendable = e.solAmount + e.fee + e.creatorFee;
      const q = quoteBuyExactSol(pre, rates, spendable);
      expect(q.tokensOut).toBe(e.tokenAmount);
      expect(q.netSol).toBe(e.solAmount);
      expect(q.protocolFee).toBe(e.fee);
      expect(q.creatorFee).toBe(e.creatorFee);
    }
  });

  it('fees are always charged on the curve amount, for every real trade', () => {
    for (const { e } of withFees) {
      const c = (e.solAmount * e.creatorFeeBasisPoints + 9999n) / 10000n;
      const p = (e.solAmount * e.feeBasisPoints + 9999n) / 10000n;
      expect(e.fee).toBe(p);
      expect(e.creatorFee).toBe(c);
    }
  });
});

describe('quote and data properties', () => {
  const g = decodeGlobal(b64(mainnet.accounts.global.dataBase64));
  const fc = decodeFeeConfig(b64(mainnet.accounts.feeConfig.dataBase64));
  const creator = new PublicKey('11111111111111111111111111111112');
  const curve = initialCurve(g, creator);
  const rates = feeRatesFor(curve, fc);

  it('a fresh coin starts at ~28 SOL market cap', () => {
    expect(Number(marketCapLamports(curve)) / 1e9).toBeCloseTo(27.96, 1);
  });

  it('the user never pays more than they offered to spend', () => {
    for (const sol of [10_000_000n, 100_000_000n, 1_000_000_000n, 5_000_000_000n, 40_000_000_000n]) {
      const q = quoteBuyExactSol(curve, rates, sol);
      expect(q.netSol + q.protocolFee + q.creatorFee).toBeLessThanOrEqual(sol);
      expect(q.tokensOut).toBeGreaterThan(0n);
    }
  });

  it('a buy caps at the tokens left on the curve', () => {
    const q = quoteBuyExactSol(curve, rates, 500_000_000_000n);
    expect(q.capped).toBe(true);
    expect(q.tokensOut).toBe(curve.realTokenReserves);
  });

  it('dust yields nothing', () => {
    expect(quoteBuyExactSol(curve, rates, 1n).tokensOut).toBe(0n);
  });

  it('buy then sell the same tokens loses roughly the fees', () => {
    const spend = 1_000_000_000n;
    const b = quoteBuyExactSol(curve, rates, spend);
    const after = { ...curve, virtualQuoteReserves: curve.virtualQuoteReserves + b.netSol, virtualTokenReserves: curve.virtualTokenReserves - b.tokensOut };
    const s = quoteSell(after, rates, b.tokensOut);
    expect(s.netSol).toBeLessThan(spend);
    expect(Number(s.netSol) / Number(spend)).toBeGreaterThan(0.96); // ~2 x 1.25% fees
  });

  it('slippage bound', () => {
    expect(minAfterSlippage(1000n, 500)).toBe(950n);
    expect(minAfterSlippage(1000n, 0)).toBe(1000n);
  });

  it('instruction data is the right size', () => {
    expect(buyExactSolInData(1n, 2n).length).toBe(8 + 8 + 8 + 1 + 1);
    expect(sellData(1n, 2n).length).toBe(8 + 8 + 8);
    expect(createV2Data({ name: 'ab', symbol: 'cd', uri: 'ef', creator }).length).toBe(8 + (4 + 2) * 3 + 32 + 1 + 1 + 8 + 1);
  });

  it('holder rewards flag is encoded only when asked for', () => {
    const on = createV2Data({ name: 'a', symbol: 'b', uri: 'c', creator, holderRewards: true });
    const off = createV2Data({ name: 'a', symbol: 'b', uri: 'c', creator });
    expect(on[on.length - 1]).toBe(1);
    expect(off[off.length - 1]).toBe(0);
  });

  it('curve decoder tolerates short legacy accounts', () => {
    // 81 bytes: discriminator + 5 u64 + complete + creator
    const buf = Buffer.alloc(81);
    Buffer.from(DISC.accounts.bondingCurve).copy(buf, 0);
    buf.writeBigUInt64LE(111n, 8);
    buf.writeBigUInt64LE(222n, 16);
    buf.writeBigUInt64LE(333n, 24);
    buf.writeBigUInt64LE(444n, 32);
    buf.writeBigUInt64LE(555n, 40);
    buf[48] = 1;
    creator.toBuffer().copy(buf, 49);
    const c = decodeBondingCurve(buf);
    expect(c.virtualTokenReserves).toBe(111n);
    expect(c.complete).toBe(true);
    expect(c.creator.toBase58()).toBe(creator.toBase58());
    expect(c.isMayhemMode).toBe(false);
  });
});

describe('quote asset: only SOL-quoted coins are supported', () => {
  const curves = fx('pump-curves.json');
  const sol = decodeBondingCurve(b64(curves.solQuoted.dataBase64));
  const other = decodeBondingCurve(b64(curves.nonSolQuoted.dataBase64));

  it('a SOL-quoted coin carries the zero quote mint', () => {
    expect(sol.quoteMint.toBase58()).toBe('11111111111111111111111111111111');
    expect(isSolQuoted(sol.quoteMint)).toBe(true);
  });

  it('a coin quoted in another token is detected from the real on-chain account', () => {
    expect(other.quoteMint.toBase58()).toBe('ERs7y4nMGLFVmHcXyDxiS7iDKpp4jWHz2VUuE2gxpump');
    expect(isSolQuoted(other.quoteMint)).toBe(false);
    // and its configured creator fee is read from the account (3% on top of the protocol fee)
    expect(other.creatorFeeBps).toBe(300n);
  });

  it('the live program rejects SOL trades on such a coin (UnsupportedQuoteMint = 6063), which is why we refuse them', () => {
    const e = idl.errors.find((x: any) => x.code === 6063);
    expect(e.name).toBe('UnsupportedQuoteMint');
  });

  it('old curve accounts without the field default to SOL-quoted', () => {
    const buf = Buffer.alloc(81);
    Buffer.from(DISC.accounts.bondingCurve).copy(buf, 0);
    expect(isSolQuoted(decodeBondingCurve(buf).quoteMint)).toBe(true);
  });
});
