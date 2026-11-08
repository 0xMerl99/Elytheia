# Elytheia

A multichain token launchpad. Create a coin once and launch it on a **Solana bonding curve (pump.fun)** and
**straight onto Uniswap v4 on Elysium** (a locked-liquidity pool that any Uniswap-compatible router can trade). Live charts,
creator fee rewards, launch protection, portfolio, docs and wallet sign-in.

**Everything is live.** Every transaction is signed in the user's own wallet on a real network. This site never holds
keys or funds; its server is a read-only indexer of public chain data (plus a small allow-listed RPC proxy).

| | Solana | Elysium (EVM) |
| --- | --- | --- |
| Network | mainnet-beta | mainnet (chain 99901) |
| Venue | **pump.fun's real program** | **Uniswap v4** pools, created by this repo's `V4Launchpad` ([`contracts/src-v4/`](contracts/src-v4), **unaudited**) |
| Status here | works today | **deployed on mainnet** (`deployments/99901-v4.json`): launchpad `0xD6265C0e1c4EFeACF228B341cdF609486DaA24F1`, hook `0x5da6799D3a45435019bB75570A58C4f4E14d4080` |
| Launch fee | none (rent + network fees only) | free by default |
| Start market cap | pump.fun's fixed curve (~28 SOL) | one tier fixed at deploy (35.65 HYPE, about $2.75K at HYPE $77) |

> **This touches real money.** The Elysium contracts have **not been audited**, and Solana launches and trades spend real
> SOL. Read [Going live safely](#going-live-safely) before you let anyone else use it.

## Run it

```bash
npm install
npm run dev          # API on :8787 + Vite UI on http://localhost:5173
```

It starts empty: no demo data, no play money. With no configuration it talks to **Solana mainnet** (through
pump.fun) and treats the EVM side as "not deployed yet" until `HYP_LAUNCHPAD` is set (see `.env.example`). From there you can:

* **Paste any pump.fun coin address** into the search bar to add it (its creation is found and verified on-chain),
  then trade it from your wallet.
* **Connect a wallet**: Phantom/Solflare/Backpack for Solana, MetaMask/Rabby/etc. for Elysium (add it with RPC `https://heliosliq.app/rpc`: elys.fun's own RPC refuses transactions to third-party contracts).
* Launching on **Solana** needs this site on a public **https** address (see `PUBLIC_URL`): a pump.fun coin's metadata
  link is permanent, so the UI refuses to launch from localhost rather than let a coin be created with a dead image.

Production: `npm run build && npm start` (one server on :8787, serving the built UI).

## Try the Elysium side risk-free, locally

Needs [Foundry](https://book.getfoundry.sh/) (`anvil`, `forge`) and the compiled v4 stack (`cd contracts && FOUNDRY_PROFILE=v4 forge build`).

```bash
npm run build
npm run chain:dev    # a local FORK of Elysium + the v4 stack deployed on it + this site pointed at it, on :8790
npm run chain:test   # the same, then a full end-to-end test through real wallets and Uniswap's own router (39 checks)
```

Open http://localhost:8790, add the printed local network to MetaMask (chain 99901, RPC `http://127.0.0.1:8545`),
import one of the printed **public anvil dev keys** (fake funds, local chain only) and launch, buy, sell and claim for
real, on a real EVM. Untick Solana on the launch page: pump.fun only exists on mainnet.

## Legacy: the original own-pool launchpad (HyperEVM instructions)

`contracts/src/Launchpad.sol` is the first version of this project's EVM side: its own constant-product pool, with holder rewards and a
wallet cap. It is **no longer what the site uses** (see the Uniswap v4 section below) but is kept, with its 36 tests, for reference.
The notes below are for that version.

> Do this only after an independent audit, with a **multisig** as `OWNER`. The deploy script refuses chain 999 unless
> you set `ALLOW_MAINNET=1`, as a deliberate speed bump (it applies to every network except a local anvil and the
> chain-998 testnet, so Elysium below is covered too). Try **testnet (chain 998) first**.

1. **Big blocks.** HyperEVM's normal blocks currently allow **3,000,000 gas** (measured on mainnet), and deploying the
   Launchpad costs **~3.27M**, so a plain deploy fails. Hyperliquid's "dual-block architecture" lets an address switch
   to *big blocks* (30M gas) for deployments. Follow Hyperliquid's current documentation to enable it for your deployer
   address, deploy, then switch it back off. Ordinary use (launching, trading: ~0.9–1.1M gas) fits normal blocks.
2. **Deploy** (use a keystore or hardware wallet rather than a raw key on the command line):

   ```bash
   cd contracts
   OWNER=0xYourMultisig ALLOW_MAINNET=1 \
     forge script script/Deploy.s.sol --rpc-url https://rpc.hyperliquid.xyz/evm --broadcast --account deployer
   ```
   `LAUNCH_FEE=<wei>` sets a per-launch fee (default 0). It is immutable once deployed.
3. **Point the site at it**: set `HYP_LAUNCHPAD=0x…` and `HYP_START_BLOCK=<deploy block>` and restart. The HyperEVM
   option turns on, and the indexer starts reading the contract's events.
4. Verify the contract on the explorer, and do a small real launch + trade + claim yourself before announcing it.

### Deploy on Elysium (chain 99901) instead

Elysium is an Arbitrum Nitro chain run by a third party (RPC `https://heliosliq.app/rpc`, native symbol HYPE). The RPC that
elys.fun publishes (`https://elys.fun/rpc`) **only relays transactions to elys.fun's own contracts** and rejects deploys and
calls to anything else, so use an RPC that does not filter (the one above was verified to be the same chain: identical block
hashes). Wallets that added Elysium from elys.fun's own RPC will hit the same refusal when they use this site, and must switch
that network's RPC URL in the wallet. Last own-pool deployment (abandoned: the site now uses the Uniswap v4 launchpad): `0x54623D0672aCa9224e2FDFd4bF88047F61518335` (block 2453498), one start-market-cap tier of 35.6 HYPE
(about $2.75K at HYPE $77). The tiers are fixed at deploy time (`--tiers 35.6` or e.g. `--tiers 35.6,71,142`); the site reads them from the
contract, so changing the start market cap means redeploying. An earlier test deployment (`0xf093…8bda`, tiers 400/800/1600) is abandoned. It has no
3M-gas block limit, so step 1 above is not needed. **Use `scripts/deploy-evm.mjs`, not `forge script`, on this chain**: on
Arbitrum-based chains forge's local simulation misses the layer-1 data cost (it would set a gas limit about half of what
is needed) and `block.number` inside a script is the L1 number, so the "deploy block" it prints is wrong for the indexer.

```bash
# 1. simulate: no key, no funds, sends nothing
ALLOW_MAINNET=1 node scripts/deploy-evm.mjs --rpc https://heliosliq.app/rpc --owner 0xYourOwnWallet --dry-run
# 2. deploy for real (~0.0026 HYPE) and write HYP_LAUNCHPAD / HYP_START_BLOCK into .env
ALLOW_MAINNET=1 node scripts/deploy-evm.mjs --rpc https://heliosliq.app/rpc --owner 0xYourOwnWallet --write-env
```

The deployer key is read from `~/.elytheia/elysium-deployer.json` (outside the project folder on purpose; use `--key-file`
to point elsewhere). `--owner` is required and should be **your own wallet or a multisig, not the deployer key**: the owner
can withdraw protocol fees. The script verifies the code, owner and fee on-chain after deploying. Then restart the server.
Set `HYP_CHAIN_ID=99901`, `HYP_CHAIN_NAME=Elysium`, `HYP_RPC_URL` and `HYP_BROWSER_RPC_URL=https://heliosliq.app/rpc` in `.env`.

Note this HYPE is **that chain's** native token, not Hyperliquid's: the USD price feed (CoinGecko "hyperliquid") only applies
if it is redeemable 1:1; otherwise pin a price with `EVM_QUOTE_USD`.

The Solidity suite also passes on a **fork of HyperEVM mainnet** (`forge test --fork-url https://rpc.hyperliquid.xyz/evm`
runs all unit and fuzz tests; the stateful invariant tests are too RPC-hungry for the public endpoint, but pass locally
across 72,000 random calls).

## Configuration

Put these in `.env` (see `.env.example`) or the environment.

| Variable | Meaning |
| --- | --- |
| `PORT`, `DATA_DIR` | server port; where the SQLite database, uploads and coin metadata live |
| `PUBLIC_URL` | This site's public **https** origin. Coin metadata links are built from it and are permanent on-chain |
| `SOL_RPC_URL` | **Use a dedicated Solana RPC for the server** (the public one rate-limits hard). It is never sent to browsers: they use `/api/solana-rpc`, an allow-listed proxy, because the public RPC refuses browser requests and paid ones carry secret keys |
| `HYP_LAUNCHPAD`, `HYP_START_BLOCK` | the deployed contract and its deploy block |
| `HYP_CHAIN_ID` / `HYP_RPC_URL` | default `999` / the public mainnet RPC (testnet is `998`) |
| `HYP_BROWSER_RPC_URL` | the RPC sent to visitors' wallets and browsers: keep any key-bearing URL out of it |
| `METADATA_HOSTS` | extra hosts allowed for coin metadata (IPFS gateways are built in) |
| `TOKEN_CA` | the project's own token (Solana mint). Shown on the landing screen with a Copy button and a `pump.fun/coin/<CA>` link; unset shows "Coming soon" |
| `X_URL` | official X account, default `https://x.com/useelytheia` (landing screen, footer) |

The opening screen plays `intro.mp4` once (no loop), then settles on the landing screen (background `public/brand/hero.jpg`,
regenerate with `python scripts/make-hero.py` or replace it with your own 16:9 image).

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | API (tsx watch) + Vite with `/api` proxy |
| `npm run build` / `npm start` | Type-check + production UI build / production server |
| `npm test` | Unit tests: market engine, **pump.fun integration**, RPC proxy allow-list (52, offline) |
| `npm run contracts:test` | Foundry suite: 36 tests incl. fuzzing and stateful invariants |
| `npm run chain:test` | Fresh local chain → deploy → server → 33 on-chain checks, then tears down |
| `npm run chain:dev` | Local HyperEVM sandbox (above) |
| `npm run pump:simulate` | Dry-runs this project's pump.fun transactions against the **live mainnet program** (nothing signed, sent or paid) |
| `npm run contracts:abi` | Rebuild contracts and regenerate `shared/launchpadAbi.ts` |

## How it works

```
contracts/              Solidity: Launchpad + LaunchToken (Foundry; tests, deploy script)
shared/market.ts       the HyperEVM pool's maths (parity-tested against the contract), used for previews
server/
  chain/evm.ts          indexes Launchpad events -> coins/trades/holdings (exactly-once, ordered)
  chain/solana.ts       indexes pump.fun TradeEvents; import-by-address; registers created coins
  chain/metadata.ts     SSRF-safe fetching of coin metadata (allow-listed hosts only)
  rpcProxy.ts           allow-list for the Solana RPC proxy
  routes.ts queries.ts auth.ts   REST API, read models, wallet-signature login
src/
  lib/evm.ts            wallet + contract calls (viem), friendly revert messages
  lib/pump.ts           pump.fun quotes, instruction/transaction builders, simulation
  lib/pumpLayout.ts     pump.fun PDAs + binary decoders (verified against the IDL and real mainnet data)
  lib/trading.ts        trade adapters: evm | pump (one UI, two chains)
  pages/ components/    Home, Create, Coin, Profile, Docs
```

The browser builds and signs transactions with the user's wallet. The indexers read the chain and write the same
`coins`, `trades` and `holdings` tables the UI reads, so feeds, charts and portfolios are always derived from chain data.
After a transaction confirms the browser calls `/api/chain/sync` so the UI updates immediately; otherwise the indexers
poll every few seconds. Every pump.fun transaction is **dry-run against the real program before the wallet prompt**.

## Deploy to Render

`render.yaml` is a Render blueprint: one Node web service that builds the site (`npm ci --include=dev && npm run build`) and runs
`npm start`, with a **persistent disk** mounted at `/var/data` (`DATA_DIR`).

1. Render dashboard -> **New** -> **Blueprint** -> pick this GitHub repo. Render reads `render.yaml`.
2. Fill the two secrets it asks for: `PUBLIC_URL` (the site's final **https** address) and `SOL_RPC_URL` (a dedicated Solana RPC;
   the public one rate-limits hard). `TOKEN_CA` is optional (the project's own token, shown on the landing page).
3. After the first deploy, set `PUBLIC_URL` to the address you will keep and redeploy. Prefer your own domain: **coin metadata links
   are written into the blockchain permanently**, so a coin launched while `PUBLIC_URL` is wrong or temporary points at a dead address
   for good. The server prints a warning at start-up while `PUBLIC_URL` is not https.

Why not Render's free plan: its filesystem is wiped on every deploy and spin-down, which would delete the database and, worse, the
image and metadata files that launched coins point to. The disk needs a paid instance type. Keep the disk's daily snapshots on.

The database is a mirror of public chain data: on a fresh disk the Elysium indexer rebuilds coins, trades and holders from
`HYP_START_BLOCK`. Solana coins are added by launching on the site or by pasting a mint into the search bar.

## Going live safely

1. **Audit the contract** before real users trust it with funds: [`contracts/README.md`](contracts/README.md) lists the
   design, known limitations and an audit checklist.
2. **Solana is a third-party program.** pump.fun can change its interface (it already has: quote mints, buybacks,
   cashback). Run `npm run pump:simulate` regularly; the app refuses coin types it doesn't understand (for example coins
   priced in another token) instead of showing wrong numbers.
3. **Public https + a real reverse proxy**; the in-memory rate limiter is single-process.
4. **Use dedicated RPC providers** for the server's indexers.

## What is verified, and how

* **HyperEVM contract** (`contracts/test`): 32 unit/fuzz tests + 4 invariants (solvency, supply accounting, reward
  conservation, pool reserves), parity vectors from the TypeScript engine, and a reentrancy attacker. All unit/fuzz
  tests also pass on a fork of the real HyperEVM mainnet.
* **pump.fun** (`tests/pump.test.ts`, `npm run pump:simulate`): discriminators vs the published IDL; account lists
  rebuilt and compared with **real mainnet transactions**; decoders vs live accounts; quotes reproduce **real executed
  trades exactly**; create, create+first-buy, holder-rewards create, buy, sell and creator-fee collection accepted by
  the live program in simulation.
* **On-chain end-to-end** (`npm run chain:test`): wallet-signature login, launch, indexing, trades, plain ERC-20
  transfers, rewards, claims and safety properties on a real EVM.
* **Browser, live**: driven against the local chain (sign-in, launch, buy, sell, claim) and against **real Solana
  mainnet** (import a real pump.fun coin, live quotes, wallet sign-in, refusal of unsupported coins), with a wallet
  that refuses to sign so nothing is ever broadcast.

**Not verified:** real wallet extensions (the code uses their standard APIs; tests use stand-in providers), a HyperEVM
mainnet or testnet deployment, and an actual pump.fun launch/trade with real SOL (only simulated against the live
program).

## Security notes

Helmet + a CSP that allows only this origin and the public HyperEVM RPC for connections, rate limiting, Zod validation
on every body, parameterised SQL, uploads verified by file signature (SVG refused), SSRF-safe metadata fetching
(allow-listed hosts, no redirects, size/time limits), an allow-listed Solana RPC proxy (no open relay), a server RPC URL
that is never sent to browsers, wallet sign-in that only ever asks for a message signature, and live transactions that
are dry-run before the wallet prompt wherever the network supports it.

### Launching straight onto Uniswap v4 (Elysium)

Uniswap has its own v4 deployment on Elysium (PoolManager `0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1`, byte-identical to
Uniswap's official HyperEVM one; Uniswap's PRs for it are still open, so it is not yet in their docs or web app). `contracts/src-v4/`
launches coins directly onto it:

- `V4Launchpad`: creating a coin deploys a plain ERC-20 (`V4Token`), creates a Uniswap v4 pool (native HYPE vs the token) and
  seeds the **entire supply** as one one-sided position from the launch price down to the lowest tick: a constant-product curve
  with a virtual reserve (about 35.65 HYPE, ~$2.75K start). The launchpad owns the position and has no function that can remove it.
  `buy`/`sell` are conveniences (slippage limits, no approval to sell); any Uniswap router can trade the same pool.
- `AntiSnipeHook`: a v4 hook that sets each swap's LP fee: 1%, plus a surcharge that starts at +20% and decays linearly to 0 over
  120 s. The creator's own launch buy skips it. All fees go to the position and are split 50/50 creator / protocol.
- Dropped compared with the own-pool launchpad: the "holder rewards" fee mode and the early per-wallet cap (a hook cannot see the
  real recipient of a router swap).

Tests run against a **fork of the real Elysium chain** with Uniswap's real PoolManager and Universal Router (both deployed router
versions buy from a launch pool in the tests):

```bash
cd contracts
FOUNDRY_PROFILE=v4 forge build
FOUNDRY_PROFILE=v4 forge test --match-path "test-v4/*"        # ELYSIUM_RPC=<url> to fork from another endpoint
```

Deploy (mines the hook address, deploys it via the standard CREATE2 deployer, deploys the launchpad, wires them, verifies on-chain,
writes `deployments/99901-v4.json`), then smoke-test:

```bash
ALLOW_MAINNET=1 node scripts/deploy-v4.mjs --rpc https://heliosliq.app/rpc --owner <your wallet> --dry-run
ALLOW_MAINNET=1 node scripts/deploy-v4.mjs --rpc https://heliosliq.app/rpc --owner <your wallet>      # asks you to type DEPLOY
ALLOW_MAINNET=1 node scripts/smoke-v4.mjs  --rpc https://heliosliq.app/rpc --launchpad <address>
```

Both scripts read the key from `~/.elytheia/elysium-deployer.json` (or `--key-file`, or `DEPLOYER_KEY`).

### After deploying: smoke test

`ALLOW_MAINNET=1 node scripts/smoke-evm.mjs --rpc <rpc> --launchpad 0x... --key-file <path>` launches a test coin, buys a
tiny amount, sells half back and checks the contract's books balance. It spends a few thousandths of HYPE and leaves a
permanent coin behind, so run it once.
