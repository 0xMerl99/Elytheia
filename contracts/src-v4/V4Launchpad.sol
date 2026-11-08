// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {FixedPoint96} from "v4-core/libraries/FixedPoint96.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {V4Token} from "./V4Token.sol";

interface IAntiSnipeHook {
    function registerLaunch(PoolKey calldata key) external;
}

/**
 * @title V4Launchpad
 * @notice Launches coins straight onto Uniswap v4. Creating a coin deploys a fixed-supply {V4Token}, creates a
 *         Uniswap v4 pool for it (native HYPE vs the token) and puts the ENTIRE supply into that pool as one
 *         one-sided liquidity position that starts at the launch price and extends down to the lowest usable
 *         price. That is exactly a constant-product curve with a virtual reserve, so every buy moves the price up
 *         smoothly and every sell moves it back down.
 *
 *  - Liquidity is locked from block zero: this contract owns the position and has no function that can remove
 *    it or move it. The pool is a normal Uniswap v4 pool, so any Uniswap-compatible router can trade it too.
 *  - The pool's swap fee is 1%, plus a decaying anti-snipe surcharge set by {AntiSnipeHook} for the first two
 *    minutes. Every fee goes to the liquidity position (this contract) and is split 50/50 between the coin's
 *    creator and the protocol.
 *  - `buy` / `sell` here are conveniences (slippage limits, no approval needed to sell). They swap through the
 *    same pool as everyone else.
 *  - AntiVamp: a name + ticker pair can only be used once.
 *
 *  The owner can do exactly one thing: withdraw accrued protocol fees. NOT AUDITED.
 */
contract V4Launchpad is Ownable2Step, ReentrancyGuard, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    /* ---------------------------------------------------------------- types */

    enum Action {
        Seed,
        Buy,
        Sell,
        Collect
    }

    struct CreateParams {
        string name;
        string symbol;
        string metadataURI;
        uint256 firstBuy; // native amount for the creator's launch buy (0 = none)
    }

    struct Coin {
        V4Token token;
        address creator;
        uint64 createdAt;
        uint256 creatorNative; // creator's share of collected fees, unclaimed (wei)
        uint256 creatorToken; // ... and in the coin's own token
    }

    /* ------------------------------------------------------------ constants */

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 * 1e6;
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_CREATOR_BUY_BPS = 2000; // launch buy capped at 20% of supply
    int24 public constant TICK_SPACING = 60;

    /* ------------------------------------------------------------ immutables */

    IPoolManager public immutable poolManager;
    address public immutable hook;
    uint256 public immutable launchFee;
    int24 public immutable startTick; // the launch price, as a Uniswap tick (a multiple of TICK_SPACING)
    int24 public immutable minTick; // the lowest usable tick: the far end of the position
    uint160 public immutable startSqrtPrice;
    uint128 public immutable seedLiquidity; // liquidity that holds the whole supply between minTick and startTick

    /* -------------------------------------------------------------- storage */

    uint256 public coinCount;
    uint256 public protocolNative; // accrued protocol fees (wei), withdrawable by the owner
    mapping(address => uint256) public protocolToken; // accrued protocol fees per coin token
    mapping(uint256 => Coin) private _coins;
    mapping(bytes32 => bool) public identityTaken;
    mapping(bytes32 => uint256) public coinOfPool; // poolId => coin id

    /* --------------------------------------------------------------- events */

    event CoinCreated(
        uint256 indexed id,
        address indexed creator,
        address token,
        string name,
        string symbol,
        string metadataURI,
        bytes32 poolId,
        uint256 startMcap, // wei
        uint256 createdAt
    );
    /// @dev Attribution only: the pool's own `Swap` event is the record of the trade. This says WHO traded through here.
    event Traded(uint256 indexed id, address indexed trader, bool isBuy, uint256 nativeAmount, uint256 tokenAmount);
    event FeesCollected(uint256 indexed id, uint256 nativeFees, uint256 tokenFees);
    event Claimed(uint256 indexed id, address indexed creator, uint256 nativeAmount, uint256 tokenAmount);
    event ProtocolFeesWithdrawn(address indexed token, address indexed to, uint256 amount);

    /* --------------------------------------------------------------- errors */

    error WrongPayment();
    error BadName();
    error BadSymbol();
    error BadMetadata();
    error AntiVamp();
    error UnknownCoin();
    error AmountTooSmall();
    error Slippage();
    error InsufficientBalance();
    error LaunchBuyTooLarge();
    error PartialFill();
    error SeedFailed();
    error NotPoolManager();
    error NotCreator();
    error NothingToClaim();
    error TransferFailed();
    error BadStartTick();

    /* ---------------------------------------------------------- constructor */

    constructor(address owner_, IPoolManager poolManager_, address hook_, uint256 launchFee_, int24 startTick_) Ownable(owner_) {
        int24 lowest = (TickMath.MIN_TICK / TICK_SPACING) * TICK_SPACING;
        if (startTick_ % TICK_SPACING != 0 || startTick_ <= lowest || startTick_ >= TickMath.MAX_TICK) revert BadStartTick();
        uint160 sqrtStart = TickMath.getSqrtPriceAtTick(startTick_);
        uint160 sqrtLow = TickMath.getSqrtPriceAtTick(lowest);

        poolManager = poolManager_;
        hook = hook_;
        launchFee = launchFee_;
        startTick = startTick_;
        minTick = lowest;
        startSqrtPrice = sqrtStart;
        // amount1 (the token) held by liquidity L between two prices is L * (sqrtB - sqrtA) / 2^96
        seedLiquidity = uint128(FullMath.mulDiv(TOTAL_SUPPLY, FixedPoint96.Q96, sqrtStart - sqrtLow));
    }

    receive() external payable {
        // native only ever arrives from the pool manager (fee collection and sells)
        if (msg.sender != address(poolManager)) revert NotPoolManager();
    }

    /* -------------------------------------------------------------- launch */

    /**
     * @notice Create a coin, its Uniswap v4 pool and its locked liquidity, and optionally make a first buy.
     * @dev msg.value must equal `launchFee + p.firstBuy`. The launch buy is capped at 20% of supply and pays only
     *      the base 1% fee (no anti-snipe surcharge).
     */
    function createCoin(CreateParams calldata p) external payable nonReentrant returns (uint256 id) {
        if (msg.value != launchFee + p.firstBuy) revert WrongPayment();
        _validate(p);

        bytes32 key32 = keccak256(abi.encode(_lower(bytes(p.name)), _lower(bytes(p.symbol))));
        if (identityTaken[key32]) revert AntiVamp();
        identityTaken[key32] = true;

        id = ++coinCount;
        V4Token token = new V4Token(p.name, p.symbol, id);

        Coin storage c = _coins[id];
        c.token = token;
        c.creator = msg.sender;
        c.createdAt = uint64(block.timestamp);
        protocolNative += launchFee;

        PoolKey memory key = _key(address(token));
        bytes32 poolId = PoolId.unwrap(key.toId());
        coinOfPool[poolId] = id;

        emit CoinCreated(id, msg.sender, address(token), p.name, p.symbol, p.metadataURI, poolId, startMarketCap(), block.timestamp);

        poolManager.initialize(key, startSqrtPrice);
        IAntiSnipeHook(hook).registerLaunch(key);
        poolManager.unlock(abi.encode(Action.Seed, abi.encode(id, p.firstBuy, msg.sender)));
    }

    /* ------------------------------------------------------------- trading */

    /// @notice Buy with the native asset sent as msg.value. Reverts if fewer than `minTokensOut` would be received.
    function buy(uint256 id, uint256 minTokensOut) external payable nonReentrant {
        _coin(id);
        if (msg.value == 0) revert AmountTooSmall();
        poolManager.unlock(abi.encode(Action.Buy, abi.encode(id, msg.sender, msg.value, minTokensOut)));
    }

    /// @notice Sell tokens back to the pool. No approval is needed. Reverts if the payout is below `minNativeOut`.
    function sell(uint256 id, uint256 tokens, uint256 minNativeOut) external nonReentrant {
        Coin storage c = _coin(id);
        if (tokens == 0) revert AmountTooSmall();
        if (tokens > c.token.balanceOf(msg.sender)) revert InsufficientBalance();
        c.token.pullFrom(msg.sender, tokens);
        poolManager.unlock(abi.encode(Action.Sell, abi.encode(id, msg.sender, tokens, minNativeOut)));
    }

    /* ---------------------------------------------------------------- fees */

    /// @notice Pull the pool's accrued swap fees into this contract and split them between the creator and the protocol.
    function collectFees(uint256 id) external nonReentrant {
        _coin(id);
        poolManager.unlock(abi.encode(Action.Collect, abi.encode(id)));
    }

    /// @notice Creator only: collect the latest fees and withdraw the creator's share (native and the coin's token).
    function claim(uint256 id) external nonReentrant {
        Coin storage c = _coin(id);
        if (msg.sender != c.creator) revert NotCreator();
        poolManager.unlock(abi.encode(Action.Collect, abi.encode(id)));
        uint256 n = c.creatorNative;
        uint256 t = c.creatorToken;
        if (n == 0 && t == 0) revert NothingToClaim();
        c.creatorNative = 0;
        c.creatorToken = 0;
        if (n > 0) {
            (bool ok,) = msg.sender.call{value: n}("");
            if (!ok) revert TransferFailed();
        }
        if (t > 0) c.token.transfer(msg.sender, t);
        emit Claimed(id, msg.sender, n, t);
    }

    /// @notice Owner only: withdraw accrued protocol fees. `token == address(0)` means the native asset.
    function withdrawProtocolFees(address token, address to) external onlyOwner nonReentrant {
        uint256 amount;
        if (token == address(0)) {
            amount = protocolNative;
            protocolNative = 0;
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            amount = protocolToken[token];
            protocolToken[token] = 0;
            V4Token(token).transfer(to, amount);
        }
        emit ProtocolFeesWithdrawn(token, to, amount);
    }

    /* ------------------------------------------------------ pool manager callback */

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Action action, bytes memory payload) = abi.decode(data, (Action, bytes));
        if (action == Action.Seed) _seed(payload);
        else if (action == Action.Buy) _buy(payload);
        else if (action == Action.Sell) _sell(payload);
        else _collect(payload);
        return "";
    }

    function _seed(bytes memory payload) private {
        (uint256 id, uint256 firstBuy, address creator) = abi.decode(payload, (uint256, uint256, address));
        Coin storage c = _coins[id];
        PoolKey memory key = _key(address(c.token));

        (BalanceDelta d,) = poolManager.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({tickLower: minTick, tickUpper: startTick, liquidityDelta: int256(uint256(seedLiquidity)), salt: bytes32(0)}),
            ""
        );
        // the position sits entirely below the launch price, so it is made only of the token
        if (d.amount0() != 0 || d.amount1() >= 0) revert SeedFailed();
        _payToken(c.token, uint256(uint128(-d.amount1())));

        if (firstBuy > 0) {
            BalanceDelta s = _swap(key, true, firstBuy, abi.encode(true)); // `true` marks the launch buy for the hook
            uint256 out = uint256(uint128(s.amount1()));
            if (out > (TOTAL_SUPPLY * MAX_CREATOR_BUY_BPS) / BPS) revert LaunchBuyTooLarge();
            poolManager.settle{value: firstBuy}();
            poolManager.take(Currency.wrap(address(c.token)), creator, out);
            emit Traded(id, creator, true, firstBuy, out);
        }
    }

    function _buy(bytes memory payload) private {
        (uint256 id, address trader, uint256 amountIn, uint256 minOut) = abi.decode(payload, (uint256, address, uint256, uint256));
        Coin storage c = _coins[id];
        BalanceDelta d = _swap(_key(address(c.token)), true, amountIn, "");
        uint256 out = uint256(uint128(d.amount1()));
        if (out == 0) revert AmountTooSmall();
        if (out < minOut) revert Slippage();
        poolManager.settle{value: amountIn}();
        poolManager.take(Currency.wrap(address(c.token)), trader, out);
        emit Traded(id, trader, true, amountIn, out);
    }

    function _sell(bytes memory payload) private {
        (uint256 id, address trader, uint256 tokensIn, uint256 minOut) = abi.decode(payload, (uint256, address, uint256, uint256));
        Coin storage c = _coins[id];
        BalanceDelta d = _swap(_key(address(c.token)), false, tokensIn, "");
        uint256 out = uint256(uint128(d.amount0()));
        if (out == 0) revert AmountTooSmall();
        if (out < minOut) revert Slippage();
        _payToken(c.token, tokensIn);
        poolManager.take(CurrencyLibrary.ADDRESS_ZERO, trader, out);
        emit Traded(id, trader, false, out, tokensIn);
    }

    function _collect(bytes memory payload) private {
        uint256 id = abi.decode(payload, (uint256));
        Coin storage c = _coins[id];
        // adding zero liquidity to the position "pokes" it: the accrued fees come back as the caller's delta
        (, BalanceDelta fees) = poolManager.modifyLiquidity(
            _key(address(c.token)),
            IPoolManager.ModifyLiquidityParams({tickLower: minTick, tickUpper: startTick, liquidityDelta: 0, salt: bytes32(0)}),
            ""
        );
        uint256 f0 = fees.amount0() > 0 ? uint256(uint128(fees.amount0())) : 0;
        uint256 f1 = fees.amount1() > 0 ? uint256(uint128(fees.amount1())) : 0;
        if (f0 > 0) {
            poolManager.take(CurrencyLibrary.ADDRESS_ZERO, address(this), f0);
            uint256 half = f0 / 2;
            c.creatorNative += half;
            protocolNative += f0 - half;
        }
        if (f1 > 0) {
            poolManager.take(Currency.wrap(address(c.token)), address(this), f1);
            uint256 half = f1 / 2;
            c.creatorToken += half;
            protocolToken[address(c.token)] += f1 - half;
        }
        emit FeesCollected(id, f0, f1);
    }

    /// @dev Exact-input swap that must fill completely. Sells may not push the price above the launch price.
    function _swap(PoolKey memory key, bool zeroForOne, uint256 amountIn, bytes memory hookData) private returns (BalanceDelta d) {
        if (amountIn == 0 || amountIn > type(uint120).max) revert AmountTooSmall();
        d = poolManager.swap(
            key,
            IPoolManager.SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : startSqrtPrice}),
            hookData
        );
        int128 spent = zeroForOne ? d.amount0() : d.amount1();
        if (spent != -int128(int256(amountIn))) revert PartialFill();
    }

    function _payToken(V4Token token, uint256 amount) private {
        poolManager.sync(Currency.wrap(address(token)));
        token.transfer(address(poolManager), amount);
        poolManager.settle();
    }

    /* ---------------------------------------------------------------- views */

    struct CoinView {
        address token;
        address creator;
        uint64 createdAt;
        bytes32 poolId;
        uint256 creatorNative;
        uint256 creatorToken;
    }

    function coinInfo(uint256 id) external view returns (CoinView memory v) {
        Coin storage c = _coin(id);
        v = CoinView(address(c.token), c.creator, c.createdAt, PoolId.unwrap(_key(address(c.token)).toId()), c.creatorNative, c.creatorToken);
    }

    function poolKeyOf(uint256 id) external view returns (PoolKey memory) {
        return _key(address(_coin(id).token));
    }

    /// @notice The pool's price and its constant-product equivalent reserves (vq in wei, vt in token units).
    function marketState(uint256 id) external view returns (uint160 sqrtPriceX96, int24 tick, uint256 vq, uint256 vt) {
        PoolId pid = _key(address(_coin(id).token)).toId();
        (sqrtPriceX96, tick,,) = poolManager.getSlot0(pid);
        vq = FullMath.mulDiv(seedLiquidity, FixedPoint96.Q96, sqrtPriceX96);
        vt = FullMath.mulDiv(seedLiquidity, sqrtPriceX96, FixedPoint96.Q96);
    }

    /// @notice Market cap at the launch price, in wei: TOTAL_SUPPLY / price.
    function startMarketCap() public view returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(TOTAL_SUPPLY, FixedPoint96.Q96, startSqrtPrice), FixedPoint96.Q96, startSqrtPrice);
    }

    /// @notice Kept for the web app, which reads the start market cap(s) from the contract. There is exactly one.
    function startMcapTiers() external view returns (uint256[] memory tiers) {
        tiers = new uint256[](1);
        tiers[0] = startMarketCap();
    }

    /* ------------------------------------------------------------- internals */

    function _key(address token) private view returns (PoolKey memory) {
        return PoolKey({
            currency0: CurrencyLibrary.ADDRESS_ZERO,
            currency1: Currency.wrap(token),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });
    }

    function _coin(uint256 id) internal view returns (Coin storage c) {
        c = _coins[id];
        if (address(c.token) == address(0)) revert UnknownCoin();
    }

    function _validate(CreateParams calldata p) internal pure {
        uint256 n = bytes(p.name).length;
        if (n == 0 || n > 32) revert BadName();
        bytes calldata sym = bytes(p.symbol);
        if (sym.length < 2 || sym.length > 10) revert BadSymbol();
        for (uint256 i = 0; i < sym.length; i++) {
            bytes1 ch = sym[i];
            bool ok = (ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x5A) || (ch >= 0x61 && ch <= 0x7A);
            if (!ok) revert BadSymbol();
        }
        if (bytes(p.metadataURI).length > 256) revert BadMetadata();
    }

    function _lower(bytes memory b) internal pure returns (bytes memory out) {
        out = new bytes(b.length);
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 ch = b[i];
            out[i] = (ch >= 0x41 && ch <= 0x5A) ? bytes1(uint8(ch) + 32) : ch;
        }
    }
}
