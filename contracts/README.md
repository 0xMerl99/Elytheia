# Launchpad contracts

Foundry project. Solidity 0.8.28, `evm_version = paris` (no PUSH0 / transient storage, so it runs on any EVM chain).

> **NOT AUDITED.** Do not deploy to a network holding real value until it has been independently reviewed.

```bash
forge build
forge test                      # 31 tests
FOUNDRY_INVARIANT_RUNS=600 FOUNDRY_INVARIANT_DEPTH=120 forge test --match-contract LaunchpadInvariantTest
forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast --private-key <key>
```

## Design

* `LaunchToken`: fixed supply of 1,000,000,000 (6 decimals), minted once to the Launchpad. No owner, mint, burn,
  pause or blacklist. Every transfer notifies the Launchpad (before/after) so holder rewards are settled against the
  right balance. Plain transfers *to* the pool revert (tokens would be lost); selling goes through `pullFrom`.
* `Launchpad`: one contract holds every coin's liquidity. Pricing is constant-product with a virtual quote reserve
  (the chosen start market cap). There is no LP token and no function that can withdraw pool liquidity.
* Fees: 1% per trade, half to the protocol and half to the creator **or** shared pro-rata with all holders (chosen at
  launch, permanent). A decaying anti-snipe surcharge (20% -> 0 over 120 s, protocol) and a per-wallet cap (1.5% of
  supply for 120 s) apply on launch.
* `createCoin` takes one calldata struct (stack depth) and can include the creator's launch buy (capped at 20%).
* **Privileged actions: exactly one.** The owner (`Ownable2Step`) can `withdrawProtocolFees`, which only moves the
  `protocolFees` counter. Pool liquidity, creator fees and holder rewards are separate accounting.
* Reentrancy: `nonReentrant` on every state-changing entry point, checks-effects-interactions, pull-style payouts.
* The AntiVamp registry keys on `keccak256(lower(name), lower(symbol))`.

## Invariants (tested)

1. `address(pad).balance >= Σ(realQuote + creatorFees + holderFeesTotal - holderClaimed) + protocolFees`
2. `coin.sold == totalSupply - balanceOf(pad)` and holder balances sum to `sold`
3. Σ(holder pending) `<= holderFeesTotal - holderClaimed` (holders are never credited more than was collected)
4. `vq == startMcap + realQuote` and `vt == balanceOf(pad)`

The tests also assert **byte-for-byte parity** with `shared/market.ts` (the TypeScript engine the web app previews with)
on fixed vectors, and a reentrancy attacker contract.

> The invariant suite caught a real bug during development: booking the *rounded-down* distribution as "collected"
> let many tiny roundings add up to more owed than collected. The fix books the full creator-side fee.

## Known limitations (read before deploying)

* **Per-wallet cap is sybil-able.** Splitting across wallets bypasses the 1.5% early limit; it deters casual sniping, not
  determined actors.
* **Holder rewards count every non-pool holder**, including contracts (e.g. a DEX pair someone creates). Tokens a
  contract can't claim with simply stay reserved. Sub-wei rounding dust also stays in the contract.
* **Protocol owner key = protocol fees only.** Use a multisig for `OWNER`; a compromised owner cannot touch liquidity.
* **No upgradeability, no pause** (by design): bugs cannot be patched on a deployed instance.
* Native quote asset is assumed to have 18 decimals.
* The indexer treats the chain head as final (fast-finality chains / local nodes). Add a confirmation depth for chains
  that reorg.
* A coin's metadata URI is immutable once created.

## Audit checklist

- [ ] Reentrancy on `sell`/`claim`/`withdrawProtocolFees` (ETH sent via `call`) and the token hooks (`before/afterTokenTransfer`)
- [ ] Hook authorisation (`msg.sender == coin.token`) and the `_pulling` flag in `LaunchToken`
- [ ] Reward accounting across transfers, claims, mixed buy/sell orderings (see invariants)
- [ ] Rounding direction everywhere funds move (buy: floor tokens; sell: floor payout; fees: floor)
- [ ] `createCoin` payment equality and first-buy cap; AntiVamp key construction (ABI encoding of two `bytes`)
- [ ] Overflow bounds: `vt * net` etc. stay far below 2^256 for supply 1e15 and any realistic quote amounts
- [ ] Gas griefing via many holders (none: no loops over holders) and event volume
- [ ] Differences between target chain and `paris` assumptions (HyperEVM specifics, native token behaviour)
