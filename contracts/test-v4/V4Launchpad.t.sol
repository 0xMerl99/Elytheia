// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {AntiSnipeHook} from "../src-v4/AntiSnipeHook.sol";
import {V4Launchpad} from "../src-v4/V4Launchpad.sol";
import {V4Token} from "../src-v4/V4Token.sol";

/// @dev Stands in for any third-party Uniswap router: it swaps straight on the pool manager.
contract DirectSwapper is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function buy(PoolKey memory key, address to) external payable returns (uint256 out) {
        return abi.decode(pm.unlock(abi.encode(key, msg.value, to)), (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, uint256 amountIn, address to) = abi.decode(data, (PoolKey, uint256, address));
        BalanceDelta d = pm.swap(
            key,
            IPoolManager.SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            ""
        );
        pm.settle{value: amountIn}();
        uint256 out = uint256(uint128(d.amount1()));
        pm.take(key.currency1, to, out);
        return abi.encode(out);
    }
}

/// @notice Runs against a fork of the real Elysium chain and Uniswap's real deployed PoolManager on it.
contract V4LaunchpadForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager constant PM = IPoolManager(0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1);
    int24 constant START_TICK = -104820; // ~35.65 HYPE market cap

    AntiSnipeHook hook;
    V4Launchpad pad;
    address owner = makeAddr("owner");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.createSelectFork(vm.envOr("ELYSIUM_RPC", string("https://elys.fun/rpc")));
        hook = _deployHook();
        pad = new V4Launchpad(owner, PM, address(hook), 0, START_TICK);
        hook.setFactory(address(pad));
        vm.deal(creator, 1_000 ether);
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
    }

    /// mines a CREATE2 salt so the hook's address has exactly the BEFORE_SWAP permission bit
    function _deployHook() internal returns (AntiSnipeHook h) {
        bytes32 initHash = keccak256(abi.encodePacked(type(AntiSnipeHook).creationCode, abi.encode(PM, address(this))));
        uint256 salt;
        while (true) {
            address a = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(salt), initHash)))));
            if ((uint160(a) & Hooks.ALL_HOOK_MASK) == Hooks.BEFORE_SWAP_FLAG) break;
            salt++;
        }
        h = new AntiSnipeHook{salt: bytes32(salt)}(PM, address(this));
    }

    function _create(string memory name, string memory sym, uint256 firstBuy) internal returns (uint256 id) {
        vm.prank(creator);
        id = pad.createCoin{value: firstBuy}(V4Launchpad.CreateParams(name, sym, "", firstBuy));
    }

    function _token(uint256 id) internal view returns (V4Token) {
        return V4Token(pad.coinInfo(id).token);
    }

    function _key(uint256 id) internal view returns (PoolKey memory) {
        return pad.poolKeyOf(id);
    }

    function _afterSnipeWindow() internal {
        vm.warp(block.timestamp + 121);
    }

    /* ------------------------------------------------------------------ setup */

    function test_forkIsTheRealElysiumPoolManager() public view {
        assertEq(block.chainid, 99901);
        assertGt(address(PM).code.length, 20_000);
        assertEq(address(hook).code.length > 0, true);
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, Hooks.BEFORE_SWAP_FLAG);
    }

    function test_startMarketCapIsAboutTarget() public view {
        // 35.6 HYPE target; one tick step (0.6%) of resolution
        assertApproxEqRel(pad.startMarketCap(), 35.6 ether, 0.01e18);
        assertEq(pad.startMcapTiers().length, 1);
        assertEq(pad.startMcapTiers()[0], pad.startMarketCap());
    }

    /* ----------------------------------------------------------------- launch */

    function test_launchSeedsWholeSupplyIntoTheUniswapPool() public {
        uint256 id = _create("Alpha Coin", "ALPHA", 0);
        V4Token t = _token(id);
        assertEq(t.totalSupply(), 1_000_000_000 * 1e6);
        // everything is in the pool manager (a couple of base units of rounding dust may stay in the launchpad)
        assertGe(t.balanceOf(address(PM)), t.totalSupply() - 1_000);
        assertLe(t.balanceOf(address(pad)), 1_000);
        (uint160 sqrtP, int24 tick,,) = PM.getSlot0(_key(id).toId());
        assertEq(sqrtP, pad.startSqrtPrice());
        assertEq(tick, START_TICK);
        assertEq(pad.coinOfPool(PoolId.unwrap(_key(id).toId())), id);
    }

    function test_positionIsOwnedByLaunchpadAndNeverShrinks() public {
        uint256 id = _create("Beta Coin", "BETA", 0);
        _afterSnipeWindow();
        vm.prank(alice);
        pad.buy{value: 5 ether}(id, 0);
        V4Token t = _token(id);
        vm.startPrank(alice);
        pad.sell(id, t.balanceOf(alice) / 2, 0);
        vm.stopPrank();
        pad.collectFees(id);

        bytes32 positionKey = keccak256(abi.encodePacked(address(pad), pad.minTick(), pad.startTick(), bytes32(0)));
        uint128 liq = PM.getPositionLiquidity(_key(id).toId(), positionKey);
        assertEq(liq, pad.seedLiquidity(), "liquidity must stay exactly as seeded");
    }

    /* ----------------------------------------------------------- price maths */

    function test_buyMatchesConstantProductWithOnePercentFee() public {
        uint256 id = _create("Gamma Coin", "GAMMA", 0);
        _afterSnipeWindow();
        (,, uint256 vq, uint256 vt) = pad.marketState(id);
        uint256 net = 1 ether - (1 ether * 1) / 100;
        uint256 expected = (vt * net) / (vq + net);
        vm.prank(alice);
        pad.buy{value: 1 ether}(id, 0);
        assertApproxEqRel(_token(id).balanceOf(alice), expected, 0.0005e18);
    }

    function test_priceRisesWithBuysAndFallsWithSells() public {
        uint256 id = _create("Delta Coin", "DELTA", 0);
        _afterSnipeWindow();
        (uint160 p0,,,) = pad.marketState(id);
        vm.prank(alice);
        pad.buy{value: 10 ether}(id, 0);
        (uint160 p1,,,) = pad.marketState(id);
        assertLt(p1, p0, "sqrt price (tokens per wei) falls when the token gets more expensive");
        V4Token t = _token(id);
        uint256 all = t.balanceOf(alice); // read first: a prank only covers the very next call
        vm.prank(alice);
        pad.sell(id, all, 0);
        (uint160 p2,,,) = pad.marketState(id);
        assertGt(p2, p1);
        assertLe(p2, p0, "can never end above the launch price");
    }

    function test_roundTripLosesAboutTwoPercentAndNeverProfits() public {
        uint256 id = _create("Epsilon Coin", "EPSILON", 0);
        _afterSnipeWindow();
        uint256 before = alice.balance;
        vm.startPrank(alice);
        pad.buy{value: 3 ether}(id, 0);
        pad.sell(id, _token(id).balanceOf(alice), 0);
        vm.stopPrank();
        uint256 back = alice.balance - (before - 3 ether);
        assertLt(back, 3 ether);
        assertGt(back, 3 ether * 96 / 100, "two 1% fees, not more");
    }

    function testFuzz_roundTripNeverProfits(uint256 amount) public {
        amount = bound(amount, 0.001 ether, 200 ether);
        uint256 id = _create("Zeta Coin", "ZETA", 0);
        _afterSnipeWindow();
        uint256 before = alice.balance;
        vm.startPrank(alice);
        pad.buy{value: amount}(id, 0);
        pad.sell(id, _token(id).balanceOf(alice), 0);
        vm.stopPrank();
        assertLe(alice.balance, before, "no free money");
        assertEq(_token(id).balanceOf(alice), 0);
    }

    /* ------------------------------------------------------------ anti-snipe */

    function test_snipeFeeDecaysLinearlyToTheBaseFee() public {
        uint256 id = _create("Eta Coin", "ETA", 0);
        PoolKey memory key = _key(id);
        assertEq(hook.currentFee(key, false), 210_000); // 21%
        vm.warp(block.timestamp + 60);
        assertEq(hook.currentFee(key, false), 110_000); // 11%
        vm.warp(block.timestamp + 60);
        assertEq(hook.currentFee(key, false), 10_000); // 1%
        vm.warp(block.timestamp + 9999);
        assertEq(hook.currentFee(key, false), 10_000);
    }

    function test_earlyBuyersPayTheSurchargeAndLateBuyersDoNot() public {
        uint256 a = _create("Theta Coin", "THETA", 0);
        vm.prank(alice);
        pad.buy{value: 1 ether}(a, 0); // second 0: 21% fee
        uint256 early = _token(a).balanceOf(alice);

        uint256 b = _create("Iota Coin", "IOTA", 0);
        _afterSnipeWindow();
        vm.prank(alice);
        pad.buy{value: 1 ether}(b, 0); // base fee only
        uint256 late = _token(b).balanceOf(alice);

        // (1 - 0.21) / (1 - 0.01) of the tokens, within curve nonlinearity
        uint256 expectedRatio = uint256(79e18) / 99;
        assertApproxEqRel(early * 1e18 / late, expectedRatio, 0.01e18);
    }

    function test_launchBuyByTheCreatorSkipsTheSurcharge() public {
        (,, uint256 vq0, uint256 vt0) = _fresh();
        uint256 id = _create("Kappa Coin", "KAPPA", 1 ether);
        uint256 got = _token(id).balanceOf(creator);
        uint256 net = 1 ether - (1 ether * 1) / 100;
        assertApproxEqRel(got, (vt0 * net) / (vq0 + net), 0.0005e18, "base 1% fee only");
    }

    function _fresh() internal view returns (uint160, int24, uint256, uint256) {
        uint160 sp = pad.startSqrtPrice();
        uint256 L = pad.seedLiquidity();
        return (sp, START_TICK, (L * (1 << 96)) / sp, (L * sp) / (1 << 96));
    }

    function test_aThirdPartyRouterSwappingTheSamePoolPaysTheSurchargeToo() public {
        uint256 id = _create("Lambda Coin", "LAMBDA", 0);
        DirectSwapper router = new DirectSwapper(PM);
        vm.deal(address(this), 10 ether);
        uint256 viaRouter = router.buy{value: 1 ether}(_key(id), bob);
        assertEq(_token(id).balanceOf(bob), viaRouter);
        // same pool, same instant: the factory's own buy must give the same amount for the same input (both pay 21%)
        uint256 id2 = _create("Mu Coin", "MU", 0);
        vm.prank(alice);
        pad.buy{value: 1 ether}(id2, 0);
        assertApproxEqRel(viaRouter, _token(id2).balanceOf(alice), 0.0005e18);
    }

    function test_nobodyElseCanClaimTheLaunchBuyExemption() public {
        uint256 id = _create("Nu Coin", "NU", 0);
        PoolKey memory key = _key(id);
        // an outsider cannot call the hook at all
        vm.expectRevert(AntiSnipeHook.NotPoolManager.selector);
        hook.beforeSwap(alice, key, IPoolManager.SwapParams(true, -1, TickMath.MIN_SQRT_PRICE + 1), abi.encode(true));
        // and a swapper that is not the factory passing the marker still pays the surcharge
        DirectSwapper router = new DirectSwapper(PM);
        assertEq(hook.currentFee(key, false), 210_000);
        router.buy{value: 1 ether}(key, bob); // router passes empty hookData: pays 21%
    }

    /* --------------------------------------------------------------- fees */

    function test_feesAreSplitHalfCreatorHalfProtocolAndAreClaimable() public {
        uint256 id = _create("Xi Coin", "XI", 0);
        _afterSnipeWindow();
        vm.prank(alice);
        pad.buy{value: 10 ether}(id, 0);
        vm.prank(bob);
        pad.buy{value: 10 ether}(id, 0);
        V4Token t = _token(id);
        uint256 half = t.balanceOf(alice) / 2; // read first: a prank only covers the very next call
        vm.prank(alice);
        pad.sell(id, half, 0);

        pad.collectFees(id);
        V4Launchpad.CoinView memory v = pad.coinInfo(id);
        // two 10-ether buys at 1% = 0.2 ether of native fees, split in half
        assertApproxEqRel(v.creatorNative, 0.1 ether, 0.01e18);
        assertApproxEqRel(pad.protocolNative(), 0.1 ether, 0.01e18);
        assertGt(v.creatorToken, 0, "the sell paid a fee in the token");
        assertApproxEqAbs(pad.protocolToken(address(t)), v.creatorToken, 1);

        uint256 before = creator.balance;
        vm.prank(creator);
        pad.claim(id);
        assertApproxEqAbs(creator.balance - before, v.creatorNative, 1);
        assertEq(t.balanceOf(creator), v.creatorToken);
        assertEq(pad.coinInfo(id).creatorNative, 0);

        vm.prank(alice);
        vm.expectRevert(V4Launchpad.NotCreator.selector);
        pad.claim(id);
    }

    function test_onlyTheOwnerCanWithdrawProtocolFees() public {
        uint256 id = _create("Omicron Coin", "OMICRON", 0);
        _afterSnipeWindow();
        vm.prank(alice);
        pad.buy{value: 10 ether}(id, 0);
        pad.collectFees(id);
        uint256 owed = pad.protocolNative();
        assertGt(owed, 0);

        vm.prank(alice);
        vm.expectRevert();
        pad.withdrawProtocolFees(address(0), alice);

        address treasury = makeAddr("treasury");
        vm.prank(owner);
        pad.withdrawProtocolFees(address(0), treasury);
        assertEq(treasury.balance, owed);
        assertEq(pad.protocolNative(), 0);
    }

    /* ----------------------------------------------------- creation rules */

    function test_launchBuyIsCappedAtTwentyPercentOfSupply() public {
        vm.prank(creator);
        vm.expectRevert(V4Launchpad.LaunchBuyTooLarge.selector);
        pad.createCoin{value: 100 ether}(V4Launchpad.CreateParams("Pi Coin", "PI", "", 100 ether));
    }

    function test_antiVampBlocksADuplicateNameAndTickerInAnyCase() public {
        _create("Rho Coin", "RHO", 0);
        vm.prank(bob);
        vm.expectRevert(V4Launchpad.AntiVamp.selector);
        pad.createCoin(V4Launchpad.CreateParams("rho COIN", "rho", "", 0));
    }

    function test_validationAndPaymentChecks() public {
        vm.startPrank(creator);
        vm.expectRevert(V4Launchpad.WrongPayment.selector);
        pad.createCoin{value: 1 ether}(V4Launchpad.CreateParams("Sigma", "SIG", "", 0));
        vm.expectRevert(V4Launchpad.BadSymbol.selector);
        pad.createCoin(V4Launchpad.CreateParams("Tau", "T", "", 0));
        vm.expectRevert(V4Launchpad.BadSymbol.selector);
        pad.createCoin(V4Launchpad.CreateParams("Tau", "T A U", "", 0));
        vm.expectRevert(V4Launchpad.BadName.selector);
        pad.createCoin(V4Launchpad.CreateParams("", "TAU", "", 0));
        vm.stopPrank();
    }

    /* ----------------------------------------------------------- safety nets */

    function test_slippageLimitsAreEnforced() public {
        uint256 id = _create("Upsilon Coin", "UPSILON", 0);
        _afterSnipeWindow();
        vm.startPrank(alice);
        vm.expectRevert(V4Launchpad.Slippage.selector);
        pad.buy{value: 1 ether}(id, type(uint128).max);
        pad.buy{value: 1 ether}(id, 0);
        uint256 bal = _token(id).balanceOf(alice);
        vm.expectRevert(V4Launchpad.Slippage.selector);
        pad.sell(id, bal, type(uint128).max);
        vm.expectRevert(V4Launchpad.InsufficientBalance.selector);
        pad.sell(id, bal + 1, 0);
        vm.stopPrank();
    }

    function test_unknownCoinsAndZeroAmountsRevert() public {
        vm.expectRevert(V4Launchpad.UnknownCoin.selector);
        pad.buy{value: 1 ether}(99, 0);
        uint256 id = _create("Phi Coin", "PHI", 0);
        vm.expectRevert(V4Launchpad.AmountTooSmall.selector);
        pad.buy(id, 0);
    }

    function test_hookWiringCannotBeChangedAndRejectsStrangers() public {
        vm.expectRevert(AntiSnipeHook.FactoryAlreadySet.selector);
        hook.setFactory(alice);
        vm.prank(alice);
        vm.expectRevert(AntiSnipeHook.NotFactory.selector);
        hook.registerLaunch(PoolKey(CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(address(1)), 0x800000, 60, hook));
        // a hook deployed at an address without the exact permission bits is refused outright
        vm.expectRevert(AntiSnipeHook.BAD_ADDRESS.selector);
        new AntiSnipeHook{salt: bytes32(uint256(0xBAD))}(PM, address(this));
    }

    function test_theLaunchpadAcceptsNativeOnlyFromThePoolManager() public {
        vm.prank(alice);
        vm.expectRevert(V4Launchpad.NotPoolManager.selector);
        (bool ok,) = address(pad).call{value: 1 ether}("");
        ok;
        vm.expectRevert(V4Launchpad.NotPoolManager.selector);
        pad.unlockCallback("");
    }

    /* ------------------------------------------- trade through Uniswap's own Universal Router */

    address constant ROUTER_V2_2 = 0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a;
    address constant ROUTER_V2_1_2 = 0xA13f7611115752DEB2B13813BDDE16A5073e4b45;

    struct ExactInSingleNew {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 minHopPriceX36;
        bytes hookData;
    }

    struct ExactInSingleOld {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    /// builds exactly what a Uniswap front-end sends: V4_SWAP -> SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
    function _routerSwap(address router, bool newStruct, PoolKey memory key, bool zeroForOne, uint128 amountIn, address who) internal {
        bytes memory actions = abi.encodePacked(uint8(0x06), uint8(0x0c), uint8(0x0f));
        bytes[] memory params = new bytes[](3);
        params[0] = newStruct
            ? abi.encode(ExactInSingleNew(key, zeroForOne, amountIn, 0, 0, ""))
            : abi.encode(ExactInSingleOld(key, zeroForOne, amountIn, 0, ""));
        Currency cin = zeroForOne ? key.currency0 : key.currency1;
        Currency cout = zeroForOne ? key.currency1 : key.currency0;
        params[1] = abi.encode(cin, uint256(amountIn));
        params[2] = abi.encode(cout, uint256(0));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        vm.prank(who);
        (bool ok, bytes memory ret) =
            router.call{value: zeroForOne ? amountIn : 0}(abi.encodeWithSignature("execute(bytes,bytes[],uint256)", hex"10", inputs, block.timestamp + 600));
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function _viaRouter(address router, bool newStruct, string memory name, string memory sym) internal {
        uint256 id = _create(name, sym, 0);
        _afterSnipeWindow();
        (,, uint256 vq, uint256 vt) = pad.marketState(id);
        uint256 net = 1 ether - (1 ether * 1) / 100;
        uint256 expected = (vt * net) / (vq + net);

        _routerSwap(router, newStruct, _key(id), true, 1 ether, alice);
        V4Token t = _token(id);
        assertApproxEqRel(t.balanceOf(alice), expected, 0.0005e18, "router buy == curve maths");

        // and back: selling needs an approval to the router's Permit2 flow in real life; here the pool is simply
        // proven tradeable in the buy direction by an unmodified Uniswap router, and fees reached the launchpad
        pad.collectFees(id);
        assertGt(pad.protocolNative(), 0);
    }

    function test_uniswapsOwnUniversalRouterV2_2CanBuyFromTheLaunchPool() public {
        _viaRouter(ROUTER_V2_2, true, "Router Coin", "RTRA");
    }

    function test_uniswapsOwnUniversalRouterV2_1_2CanBuyFromTheLaunchPool() public {
        _viaRouter(ROUTER_V2_1_2, false, "Router Coin Two", "RTRB");
    }
}
