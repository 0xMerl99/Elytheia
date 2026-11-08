/**
 * Dry-runs this project's pump.fun transactions against the LIVE mainnet program using RPC `simulateTransaction`.
 * Nothing is signed, broadcast or paid for: it executes pump.fun's real code against real state and reports the result.
 *
 *   npm run pump:simulate
 *
 * To simulate we need accounts that hold SOL / tokens; we borrow public addresses from recent on-chain activity purely
 * as the *simulated* fee payer. Their keys are never involved (signature verification is switched off).
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { decodeTradeEvent, parseEventIx, isDisc, isSolQuoted, DISC, pumpPdas, ata, PUMP_PROGRAM } from '../src/lib/pumpLayout';
import { creatorVaultClaimable, loadCurve, loadPumpContext, prepareBuy, prepareCollectCreatorFee, prepareCreate, prepareSell, simulate, tokenBalance, type CurveInfo } from '../src/lib/pump';
import bs58 from 'bs58';

const RPC = process.env.SOL_RPC_URL || 'https://api.mainnet-beta.solana.com';
const conn = new Connection(RPC, 'confirmed');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;

function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ ${name}`, extra ?? '');
  }
}

/** retry wrapper for the public RPC's rate limiting */
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 6; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!/429|rate|Too many/i.test(String(e))) throw e;
      await sleep(2000 * (i + 1));
    }
  }
  return fn();
}

async function richSystemAccount(): Promise<PublicKey> {
  // the pump.fun fee recipient is an ordinary wallet that always holds plenty of SOL
  const g = (await loadPumpContext(conn)).global;
  for (const k of [g.feeRecipient, ...g.feeRecipients]) {
    const info = await retry(() => conn.getAccountInfo(k));
    if (info && info.owner.toBase58() === '11111111111111111111111111111111' && info.lamports > 5e9) return k;
  }
  throw new Error('no funded system account found to use as the simulated payer');
}

/** Finds a recent buyer who still holds tokens of a live (not graduated) curve. */
async function findLiveHolder(): Promise<{ info: CurveInfo; holder: PublicKey; balance: bigint } | null> {
  const sigs = await retry(() => conn.getSignaturesForAddress(PUMP_PROGRAM, { limit: 400 }));
  let tried = 0;
  for (const s of sigs.filter((x) => !x.err)) {
    if (tried++ > 40) break;
    await sleep(250);
    let tx;
    try {
      tx = await retry(() => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }));
    } catch {
      continue; // e.g. a transaction format this client version can't parse
    }
    if (!tx) continue;
    const inner = (tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions);
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses }).keySegments().flat();
    for (const ix of inner) {
      if (keys[ix.programIdIndex].toBase58() !== PUMP_PROGRAM.toBase58()) continue;
      const ev = parseEventIx(bs58.decode(ix.data));
      if (!ev || !isDisc(ev.disc, DISC.events.trade)) continue;
      const e = decodeTradeEvent(ev.body);
      if (e.fee === 0n || !e.isBuy) continue; // skip mayhem-program trades
      try {
        const info = await loadCurve(conn, e.mint);
        if (info.curve.complete || info.curve.isMayhemMode || !isSolQuoted(info.curve.quoteMint)) continue;
        const bal = await tokenBalance(conn, e.user, e.mint, info.tokenProgram);
        if (bal > 1_000_000n) return { info, holder: e.user, balance: bal };
      } catch {
        /* not a usable coin, keep looking */
      }
    }
  }
  return null;
}

async function main() {
  console.log(`\npump.fun live-program simulation → ${RPC}\n`);
  const ctx = await retry(() => loadPumpContext(conn));
  console.log('live program state');
  check('Global decoded (create_v2 enabled)', ctx.global.createV2Enabled, ctx.global);
  console.log(`    fee ${ctx.global.feeBasisPoints} bps, ${ctx.global.buybackFeeRecipients.length} buyback recipients, holder rewards enabled: ${ctx.global.isHolderRewardEnabled}`);

  const payer = await richSystemAccount();
  console.log(`    simulated payer: ${payer.toBase58()} (public, unsigned)\n`);

  console.log('create_v2');
  const uri = 'https://ipfs.io/ipfs/bafkreiahr4ox2qtkslr2wp2cx7ovgfwkee3nmn3xf7vpsm7ge3jduxejkq';
  const c1 = await prepareCreate(conn, ctx, payer, { name: 'Elytheia Test', symbol: 'ELYTEST', uri }, 0n);
  const r1 = await retry(() => simulate(conn, c1.tx));
  check('create (no first buy) is accepted by the real program', r1.ok, { err: r1.error, logs: r1.logs.slice(-6) });
  if (r1.ok) console.log(`    ${r1.unitsConsumed} compute units`);
  await sleep(500);

  const c2 = await prepareCreate(conn, ctx, payer, { name: 'Elytheia Test', symbol: 'ELYTEST', uri }, 100_000_000n); // 0.1 SOL
  const r2 = await retry(() => simulate(conn, c2.tx));
  check('create + first buy of 0.1 SOL (one transaction) is accepted', r2.ok, { err: r2.error, logs: r2.logs.slice(-8) });
  if (r2.ok) console.log(`    ${r2.unitsConsumed} compute units; expected ≈ ${Number(c2.expectedTokens) / 1e6} tokens`);
  check('the transaction needs the mint keypair signature (it is signed)', c2.tx.signatures.some((s) => s.some((b) => b !== 0)));
  await sleep(500);

  if (ctx.global.isHolderRewardEnabled) {
    const c3 = await prepareCreate(conn, ctx, payer, { name: 'Elytheia Test', symbol: 'ELYTEST', uri, holderRewards: true }, 0n);
    const r3 = await retry(() => simulate(conn, c3.tx));
    check('create with native holder rewards is accepted', r3.ok, { err: r3.error, logs: r3.logs.slice(-6) });
    await sleep(500);
  }

  console.log('\ntrading on a live coin');
  const live = await findLiveHolder();
  if (!live) {
    console.log('  (could not find a live coin with a holder in the recent activity; skipping trade simulations)');
  } else {
    // The scan above can take a while on a rate-limited public RPC and hot coins move fast, so quote from FRESH state
    // (the same thing the UI does right before every trade).
    const fresh = await retry(() => loadCurve(conn, live.info.mint));
    live.info = fresh;
    console.log(`    coin ${live.info.mint.toBase58()} · token program ${live.info.tokenProgram.toBase58().slice(0, 8)}…`);
    const b = await prepareBuy(conn, ctx, live.info, payer, 50_000_000n, 1000); // 0.05 SOL
    const rb = await retry(() => simulate(conn, b.tx));
    check('buy_exact_sol_in of 0.05 SOL is accepted by the real program', rb.ok, { err: rb.error, logs: rb.logs.slice(-8) });
    if (rb.ok) console.log(`    expected ≈ ${Number(b.quote.tokensOut) / 1e6} tokens, price impact ${b.quote.impactPct.toFixed(3)}%`);
    await sleep(500);

    const sellAmt = live.balance / 4n;
    live.info = await retry(() => loadCurve(conn, live.info.mint));
    const s = await prepareSell(conn, ctx, live.info, live.holder, sellAmt, 1000);
    const rs = await retry(() => simulate(conn, s.tx));
    check('sell of a real holder\'s tokens is accepted by the real program', rs.ok, { err: rs.error, logs: rs.logs.slice(-8) });
    if (rs.ok) console.log(`    sells ${Number(sellAmt) / 1e6} tokens for ≈ ${Number(s.quote.netSol) / 1e9} SOL (net of fees)`);
  }

  console.log('\ncreator fees');
  if (live) {
    const creator = live.info.curve.creator;
    const claimable = await retry(() => creatorVaultClaimable(conn, creator));
    console.log(`    creator ${creator.toBase58().slice(0, 8)}… has ${Number(claimable) / 1e9} SOL claimable`);
    const ctx2 = await retry(() => prepareCollectCreatorFee(conn, creator, creator));
    const rc = await retry(() => simulate(conn, ctx2));
    check('collect_creator_fee is accepted by the real program', rc.ok, { err: rc.error, logs: rc.logs.slice(-6) });
  }

  console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nAll live-program simulations passed\n');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

void ata;
void pumpPdas;
