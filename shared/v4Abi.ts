// The few Uniswap v4 / ERC-20 ABI items the app reads. (The launchpad's own ABI is generated: see scripts/export-abi.mjs.)

/** Emitted by Uniswap's PoolManager for every swap in every pool. Amounts are from the SWAPPER's point of view: negative = paid. */
export const poolManagerSwapEvent = {
  type: 'event',
  name: 'Swap',
  inputs: [
    { indexed: true, name: 'id', type: 'bytes32' },
    { indexed: true, name: 'sender', type: 'address' },
    { indexed: false, name: 'amount0', type: 'int128' },
    { indexed: false, name: 'amount1', type: 'int128' },
    { indexed: false, name: 'sqrtPriceX96', type: 'uint160' },
    { indexed: false, name: 'liquidity', type: 'uint128' },
    { indexed: false, name: 'tick', type: 'int24' },
    { indexed: false, name: 'fee', type: 'uint24' },
  ],
} as const;

export const tokenAbi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;
