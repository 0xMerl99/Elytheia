// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";

/**
 * @title AntiSnipeHook
 * @notice A Uniswap v4 hook that sets each swap's LP fee: the 1% base fee, plus a launch surcharge that starts at
 *         +20% and decays linearly to zero over the first 120 seconds after a coin's pool is created.
 *
 *         It only acts on pools the launchpad registered through {registerLaunch}; any other pool using this hook
 *         simply pays the base fee. It never holds funds and never changes the swap amounts: the only thing it
 *         returns is a fee number, and the extra fee is paid to the pool's liquidity provider (the launchpad).
 *
 *         The launchpad's own launch buy (the creator's first purchase, made inside the creation transaction) is
 *         exempt and pays only the base fee. The launchpad marks it with hookData; the hook trusts that marker
 *         ONLY when the swap's sender is the launchpad itself, so nobody else can claim the exemption.
 *
 *         This contract's address must have exactly the BEFORE_SWAP permission bit set (see {BAD_ADDRESS}); deploy
 *         it with CREATE2 and a mined salt.
 */
contract AntiSnipeHook is IHooks {
    using PoolIdLibrary for PoolKey;

    uint24 public constant BASE_FEE = 10_000; // 1.00% in hundredths of a basis point
    uint24 public constant SNIPE_START_FEE = 200_000; // +20.00% at second 0
    uint256 public constant SNIPE_DURATION = 120; // seconds until the surcharge reaches 0

    IPoolManager public immutable poolManager;
    address public immutable setter; // may call {setFactory} exactly once
    address public factory;
    mapping(PoolId => uint256) public launchedAt;

    error NotPoolManager();
    error NotFactory();
    error NotSetter();
    error FactoryAlreadySet();
    error AlreadyRegistered();
    error HookNotImplemented();
    error BAD_ADDRESS();

    constructor(IPoolManager poolManager_, address setter_) {
        poolManager = poolManager_;
        setter = setter_;
        // the pool manager decides which hooks to call from the low bits of this contract's address
        if ((uint160(address(this)) & Hooks.ALL_HOOK_MASK) != Hooks.BEFORE_SWAP_FLAG) revert BAD_ADDRESS();
    }

    /// @notice One-time wiring: the launchpad that is allowed to register launches.
    function setFactory(address factory_) external {
        if (msg.sender != setter) revert NotSetter();
        if (factory != address(0)) revert FactoryAlreadySet();
        factory = factory_;
    }

    /// @notice Called by the launchpad right after it creates a coin's pool.
    function registerLaunch(PoolKey calldata key) external {
        if (msg.sender != factory) revert NotFactory();
        PoolId id = key.toId();
        if (launchedAt[id] != 0) revert AlreadyRegistered();
        launchedAt[id] = block.timestamp;
    }

    /// @notice The LP fee a swap in `key` would pay right now (for the UI and the tests).
    function currentFee(PoolKey calldata key, bool launchBuy) external view returns (uint24) {
        return _fee(key.toId(), launchBuy);
    }

    function _fee(PoolId id, bool launchBuy) internal view returns (uint24 fee) {
        fee = BASE_FEE;
        uint256 t0 = launchedAt[id];
        if (t0 == 0 || launchBuy) return fee;
        uint256 elapsed = block.timestamp - t0;
        if (elapsed < SNIPE_DURATION) fee += uint24((uint256(SNIPE_START_FEE) * (SNIPE_DURATION - elapsed)) / SNIPE_DURATION);
    }

    /* ------------------------------------------------------------ the one hook that does anything */

    function beforeSwap(address sender, PoolKey calldata key, IPoolManager.SwapParams calldata, bytes calldata hookData)
        external
        view
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        bool launchBuy = sender == factory && hookData.length == 32 && abi.decode(hookData, (bool));
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, _fee(key.toId(), launchBuy) | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    /* ------------------------------------------------------------ everything else is switched off */

    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function afterSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, int128)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
