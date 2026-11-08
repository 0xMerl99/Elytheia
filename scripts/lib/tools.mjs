// Small shared helpers for the EVM deploy / smoke-test scripts: argument parsing, key loading, clean errors.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const require = createRequire(import.meta.url);

export class Fail extends Error {}
export const fail = (msg) => {
  throw new Fail(msg);
};
export const short = (e) => e?.details || e?.shortMessage || String(e?.message ?? e).split('\n')[0];

export function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

/** Foundry artifact from the v4 profile: `forge build` with FOUNDRY_PROFILE=v4 first. */
export function artifact(file, name) {
  const p = path.resolve('contracts/out-v4', `${file}.sol`, `${name}.json`);
  if (!fs.existsSync(p)) fail(`contract not compiled: run \`cd contracts && FOUNDRY_PROFILE=v4 forge build\` (missing ${p})`);
  return require(p);
}

/** The private key from DEPLOYER_KEY, or from a key file (JSON {"privateKey"} or plain text; '#' lines are comments). Never printed. */
export function loadAccount() {
  let pk = process.env.DEPLOYER_KEY;
  if (!pk) {
    const keyFile = path.resolve(String(arg('key-file', path.join(os.homedir(), '.elytheia', 'elysium-deployer.json'))));
    if (!fs.existsSync(keyFile)) fail(`no key file at ${keyFile} (or set DEPLOYER_KEY)`);
    const raw = fs.readFileSync(keyFile, 'utf8');
    try {
      pk = JSON.parse(raw).privateKey;
    } catch {
      pk = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    }
    if (!pk) fail(`${keyFile} has no key in it yet`);
  }
  pk = String(pk).trim();
  if (/^[0-9a-fA-F]{64}$/.test(pk)) pk = `0x${pk}`;
  try {
    return privateKeyToAccount(pk);
  } catch {
    return fail('the key is not a valid private key');
  }
}

/** Public + wallet clients for an RPC. Real-money chains need ALLOW_MAINNET=1. */
export async function connect(rpc, account) {
  const probe = createPublicClient({ transport: http(rpc) });
  const chainId = await probe.getChainId().catch((e) => fail(`cannot reach ${rpc}: ${short(e)}`));
  const testNetwork = chainId === 31337 || chainId === 998;
  if (!testNetwork && process.env.ALLOW_MAINNET !== '1') fail(`chain ${chainId} is a real-money network and these contracts are unaudited.\nRe-run with ALLOW_MAINNET=1 to confirm you accept that.`);
  const chain = defineChain({ id: chainId, name: `chain ${chainId}`, nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const wallet = account ? createWalletClient({ account, chain, transport: http(rpc) }) : null;
  return { chainId, chain, pub, wallet, testNetwork };
}

export function run(main) {
  main().catch((e) => {
    console.error(e instanceof Fail ? `\nERROR: ${e.message}\n` : e);
    process.exitCode = 1;
  });
}
