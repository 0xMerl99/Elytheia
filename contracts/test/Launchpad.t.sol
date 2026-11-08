// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchToken} from "../src/LaunchToken.sol";

contract LaunchpadTest is Test {
    Launchpad pad;
    address owner = makeAddr("owner");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    uint256 constant LAUNCH_FEE = 0.5 ether;
    uint256 constant TOTAL = 1_000_000_000 * 1e6;

    function setUp() public {
        uint256[] memory tiers = new uint256[](3);
        tiers[0] = 400 ether;
        tiers[1] = 800 ether;
        tiers[2] = 1600 ether;
        pad = new Launchpad(owner, LAUNCH_FEE, tiers);
        vm.warp(1_700_000_000);
        vm.deal(creator, 10_000 ether);
        vm.deal(alice, 10_000 ether);
        vm.deal(bob, 10_000 ether);
        vm.deal(carol, 10_000 ether);
    }

    /* ------------------------------------------------------------ helpers */

    function _params(string memory name, string memory symbol, uint8 tier, Launchpad.FeeMode mode, uint256 firstBuy)
        internal
        pure
        returns (Launchpad.CreateParams memory)
    {
        return Launchpad.CreateParams(name, symbol, "https://example.com/meta.json", tier, mode, firstBuy);
    }

    function _create(string memory name, string memory symbol, uint8 tier, Launchpad.FeeMode mode, uint256 firstBuy)
        internal
        returns (uint256 id)
    {
        vm.prank(creator);
        id = pad.createCoin{value: LAUNCH_FEE + firstBuy}(_params(name, symbol, tier, mode, firstBuy));
    }

    function _token(uint256 id) internal view returns (LaunchToken) {
        return pad.coinInfo(id).token;
    }

    /* ----------------------------------------------------------- creation */

    function test_createCoin_basics() public {
        uint256 id = _create("Gigachad Sloth", "SLOTH", 1, Launchpad.FeeMode.Creator, 0);
        assertEq(id, 1);
        Launchpad.Coin memory c = pad.coinInfo(id);
        assertEq(c.creator, creator);
        assertEq(c.vq, 800 ether);
        assertEq(c.vt, TOTAL);
        assertEq(c.sold, 0);
        assertEq(address(c.token).code.length > 0, true);
        assertEq(c.token.totalSupply(), TOTAL);
        assertEq(c.token.balanceOf(address(pad)), TOTAL, "whole supply sits in the pool");
        assertEq(c.token.decimals(), 6);
        assertEq(c.token.name(), "Gigachad Sloth");
        assertEq(c.token.symbol(), "SLOTH");
        assertEq(pad.protocolFees(), LAUNCH_FEE);
        assertEq(address(pad).balance, LAUNCH_FEE);
    }

    function test_createCoin_withFirstBuy_paysBaseFeeOnly() public {
        uint256 id = _create("Moon Pickle", "PICKLE", 1, Launchpad.FeeMode.Creator, 10 ether);
        Launchpad.Coin memory c = pad.coinInfo(id);
        // base 1% fee even though the coin is 0s old (no anti-snipe surcharge on the launch buy)
        assertEq(c.creatorFees, (10 ether * 50) / 10_000);
        assertEq(pad.protocolFees(), LAUNCH_FEE + (10 ether * 50) / 10_000);
        assertGt(c.token.balanceOf(creator), 0);
        assertEq(c.sold, c.token.balanceOf(creator));
    }

    function test_createCoin_rejectsWrongPayment() public {
        vm.startPrank(creator);
        vm.expectRevert(Launchpad.WrongPayment.selector);
        pad.createCoin{value: LAUNCH_FEE - 1}(_params("A Coin", "AAA", 0, Launchpad.FeeMode.Creator, 0));
        vm.expectRevert(Launchpad.WrongPayment.selector);
        pad.createCoin{value: LAUNCH_FEE + 1}(_params("A Coin", "AAA", 0, Launchpad.FeeMode.Creator, 0));
        vm.stopPrank();
    }

    function test_createCoin_validation() public {
        vm.startPrank(creator);
        vm.expectRevert(Launchpad.BadTier.selector);
        pad.createCoin{value: LAUNCH_FEE}(_params("X Coin", "XX", 3, Launchpad.FeeMode.Creator, 0));
        vm.expectRevert(Launchpad.BadName.selector);
        pad.createCoin{value: LAUNCH_FEE}(_params("", "XX", 0, Launchpad.FeeMode.Creator, 0));
        vm.expectRevert(Launchpad.BadName.selector);
        pad.createCoin{value: LAUNCH_FEE}(_params("123456789012345678901234567890123", "XX", 0, Launchpad.FeeMode.Creator, 0));
        vm.expectRevert(Launchpad.BadSymbol.selector);
        pad.createCoin{value: LAUNCH_FEE}(_params("Ok", "X", 0, Launchpad.FeeMode.Creator, 0));
        vm.expectRevert(Launchpad.BadSymbol.selector);
        pad.createCoin{value: LAUNCH_FEE}(_params("Ok", "A B", 0, Launchpad.FeeMode.Creator, 0));
        vm.expectRevert(Launchpad.BadSymbol.selector);
        pad.createCoin{value: LAUNCH_FEE}(_params("Ok", "WAYTOOLONGSYM", 0, Launchpad.FeeMode.Creator, 0));
        vm.stopPrank();
    }

    function test_antiVamp_blocksCaseInsensitiveDuplicates() public {
        _create("Moon Pickle", "PICKLE", 0, Launchpad.FeeMode.Creator, 0);
        vm.prank(alice);
        vm.expectRevert(Launchpad.AntiVamp.selector);
        pad.createCoin{value: LAUNCH_FEE}(_params("moon pickle", "pickle", 0, Launchpad.FeeMode.Creator, 0));
        // same name, different ticker is fine, and so is the reverse
        vm.prank(alice);
        pad.createCoin{value: LAUNCH_FEE}(_params("Moon Pickle", "PICKL2", 0, Launchpad.FeeMode.Creator, 0));
        vm.prank(alice);
        pad.createCoin{value: LAUNCH_FEE}(_params("Different", "PICKLE", 0, Launchpad.FeeMode.Creator, 0));
    }

    function test_launchBuy_cappedAt20Percent() public {
        // on the 400 tier, ~101 HYPE buys 20%: 150 must be rejected, 50 accepted
        vm.prank(creator);
        vm.expectRevert(Launchpad.LaunchBuyTooLarge.selector);
        pad.createCoin{value: LAUNCH_FEE + 150 ether}(_params("Big", "BIG", 0, Launchpad.FeeMode.Creator, 150 ether));
        _create("Fine", "FINE", 0, Launchpad.FeeMode.Creator, 50 ether);
    }

    /* ------------------------------------- parity with the TypeScript engine */

    /// Vectors generated by shared/market.ts (quote values there are in 1e-9 units, here wei = x1e9).
    function test_parity_buyThenSell_vectorA() public {
        uint256 id = _create("Parity", "PAR", 1, Launchpad.FeeMode.Creator, 0);
        vm.warp(block.timestamp + 500); // past the anti-snipe window: plain 1% fee

        vm.prank(alice);
        pad.buy{value: 10 ether}(id, 0);
        Launchpad.Coin memory c = pad.coinInfo(id);
        assertEq(c.token.balanceOf(alice), 12_223_731_324_854, "tokens out");
        assertEq(c.vq, 809_900_000_000 * 1e9, "vq");
        assertEq(c.vt, 987_776_268_675_146, "vt");
        assertEq(c.creatorFees, 50_000_000 * 1e9, "creator fee");
        assertEq(pad.protocolFees(), LAUNCH_FEE + 50_000_000 * 1e9, "protocol fee");

        uint256 sellTokens = 6_111_865_662_427;
        uint256 before = alice.balance;
        vm.prank(alice);
        pad.sell(id, sellTokens, 0);
        c = pad.coinInfo(id);
        // the TS engine rounds quote amounts to 1e-9 units, the contract keeps full wei precision: allow 1 TS unit
        assertApproxEqAbs(alice.balance - before, 4_930_635_381 * 1e9, 1e9, "sell payout");
        assertApproxEqAbs(c.vq, 804_919_560_222 * 1e9, 1e9, "vq after sell");
        assertEq(c.vt, 993_888_134_337_573, "vt after sell");
    }

    function test_parity_antiSnipeFee_vectorB() public {
        uint256 id = _create("Snipe", "SNP", 0, Launchpad.FeeMode.Creator, 0);
        vm.warp(block.timestamp + 30);
        assertEq(pad.currentFeeBps(id), 1600);
        vm.prank(alice);
        pad.buy{value: 5 ether}(id, 0);
        Launchpad.Coin memory c = pad.coinInfo(id);
        assertEq(c.token.balanceOf(alice), 10_390_895_596_239, "tokens out");
        assertEq(c.creatorFees, 25_000_000 * 1e9, "creator fee");
        assertEq(pad.protocolFees(), LAUNCH_FEE + 775_000_000 * 1e9, "protocol fee incl. surcharge");
    }

    function test_feeDecaysLinearly() public {
        uint256 id = _create("Decay", "DEC", 1, Launchpad.FeeMode.Creator, 0);
        assertEq(pad.currentFeeBps(id), 2100);
        vm.warp(block.timestamp + 60);
        assertEq(pad.currentFeeBps(id), 1100);
        vm.warp(block.timestamp + 60);
        assertEq(pad.currentFeeBps(id), 100);
        vm.warp(block.timestamp + 10_000);
        assertEq(pad.currentFeeBps(id), 100);
    }

    /* ------------------------------------------------ launch protection */

    function test_earlyWalletCap() public {
        uint256 id = _create("Cap", "CAP", 0, Launchpad.FeeMode.Creator, 0);
        // 20 HYPE on the 400 tier buys well over 1.5% of supply
        vm.prank(alice);
        vm.expectRevert(Launchpad.EarlyWalletLimit.selector);
        pad.buy{value: 20 ether}(id, 0);
        // small buys are fine, until the wallet reaches the cap
        vm.prank(alice);
        pad.buy{value: 4 ether}(id, 0);
        // the creator is exempt from the cap (but not from the fee)
        vm.prank(creator);
        pad.buy{value: 20 ether}(id, 0);
        // once the window closes the cap is gone
        vm.warp(block.timestamp + 121);
        vm.prank(alice);
        pad.buy{value: 20 ether}(id, 0);
        assertEq(pad.walletLimit(id), 0);
    }

    function test_slippageProtection() public {
        uint256 id = _create("Slip", "SLP", 1, Launchpad.FeeMode.Creator, 0);
        vm.warp(block.timestamp + 200);
        (uint256 quoted,,) = pad.quoteBuy(id, 5 ether);
        vm.prank(alice);
        vm.expectRevert(Launchpad.Slippage.selector);
        pad.buy{value: 5 ether}(id, quoted + 1);
        vm.prank(alice);
        pad.buy{value: 5 ether}(id, quoted);
        assertEq(_token(id).balanceOf(alice), quoted, "quote == execution");
    }

    function test_cannotSellMoreThanOwned() public {
        uint256 id = _create("Own", "OWN", 1, Launchpad.FeeMode.Creator, 0);
        vm.warp(block.timestamp + 200);
        vm.prank(alice);
        pad.buy{value: 1 ether}(id, 0);
        uint256 bal = _token(id).balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(Launchpad.InsufficientBalance.selector);
        pad.sell(id, bal + 1, 0);
        vm.prank(bob);
        vm.expectRevert(Launchpad.InsufficientBalance.selector);
        pad.sell(id, 1, 0);
    }

    function test_directTransferToPoolReverts() public {
        uint256 id = _create("Direct", "DIR", 1, Launchpad.FeeMode.Creator, 1 ether);
        LaunchToken t = _token(id);
        vm.prank(creator);
        vm.expectRevert(LaunchToken.DirectTransferToPool.selector);
        t.transfer(address(pad), 1);
    }

    function test_pullFromOnlyLaunchpad() public {
        uint256 id = _create("Pull", "PUL", 1, Launchpad.FeeMode.Creator, 1 ether);
        LaunchToken t = _token(id);
        vm.prank(alice);
        vm.expectRevert(LaunchToken.OnlyLaunchpad.selector);
        t.pullFrom(creator, 1);
    }

    function test_hooksOnlyFromToken() public {
        uint256 id = _create("Hook", "HOK", 1, Launchpad.FeeMode.Creator, 0);
        vm.prank(alice);
        vm.expectRevert(Launchpad.NotToken.selector);
        pad.beforeTokenTransfer(id, alice, bob);
        vm.prank(alice);
        vm.expectRevert(Launchpad.NotToken.selector);
        pad.afterTokenTransfer(id, alice, bob);
    }

    function test_unknownCoinReverts() public {
        vm.expectRevert(Launchpad.UnknownCoin.selector);
        pad.coinInfo(42);
        vm.prank(alice);
        vm.expectRevert(Launchpad.UnknownCoin.selector);
        pad.buy{value: 1 ether}(42, 0);
    }

    /* ----------------------------------------------------------- rewards */

    function test_creatorFees_accrueAndClaim() public {
        uint256 id = _create("Fees", "FEE", 1, Launchpad.FeeMode.Creator, 0);
        vm.warp(block.timestamp + 500);
        vm.prank(alice);
        pad.buy{value: 100 ether}(id, 0);
        (uint256 holderAmt, uint256 creatorAmt) = pad.pending(id, creator);
        assertEq(holderAmt, 0);
        assertEq(creatorAmt, 0.5 ether); // 0.5% of 100
        uint256 before = creator.balance;
        vm.prank(creator);
        pad.claim(id);
        assertEq(creator.balance - before, 0.5 ether);
        vm.prank(creator);
        vm.expectRevert(Launchpad.NothingToClaim.selector);
        pad.claim(id);
        // someone who is not the creator and holds nothing cannot claim
        vm.prank(bob);
        vm.expectRevert(Launchpad.NothingToClaim.selector);
        pad.claim(id);
    }

    function test_holderRewards_proRata_andBuyerDoesNotEarnOwnFee() public {
        uint256 id = _create("Holders", "HLD", 1, Launchpad.FeeMode.Holders, 0);
        vm.warp(block.timestamp + 500);
        // Alice is the first holder. Nobody held anything when she paid, so her fee went to the protocol.
        vm.prank(alice);
        pad.buy{value: 10 ether}(id, 0);
        (uint256 a0,) = pad.pending(id, alice);
        assertEq(a0, 0, "a buyer never earns from their own purchase");
        assertEq(pad.coinInfo(id).holderFeesTotal, 0);

        // Bob buys: 0.5% of 20 = 0.1 HYPE is split over the PRE-trade holders (only Alice)
        vm.prank(bob);
        pad.buy{value: 20 ether}(id, 0);
        (uint256 a1,) = pad.pending(id, alice);
        (uint256 b1,) = pad.pending(id, bob);
        assertApproxEqAbs(a1, 0.1 ether, 1e9, "alice gets all of bob's holder fee");
        assertEq(b1, 0, "bob earns nothing from his own buy");

        // Carol buys: fee split between Alice and Bob in proportion to their balances
        vm.prank(carol);
        pad.buy{value: 30 ether}(id, 0);
        LaunchToken t = _token(id);
        uint256 balA = t.balanceOf(alice);
        uint256 balB = t.balanceOf(bob);
        (uint256 a2,) = pad.pending(id, alice);
        (uint256 b2,) = pad.pending(id, bob);
        uint256 fee = 0.15 ether; // 0.5% of 30
        assertApproxEqAbs(a2 - a1, (fee * balA) / (balA + balB), 1e9);
        assertApproxEqAbs(b2, (fee * balB) / (balA + balB), 1e9);

        // claiming pays out and zeroes
        uint256 before = alice.balance;
        vm.prank(alice);
        pad.claim(id);
        assertApproxEqAbs(alice.balance - before, a2, 1);
        (uint256 a3,) = pad.pending(id, alice);
        assertEq(a3, 0);
        vm.prank(alice);
        vm.expectRevert(Launchpad.NothingToClaim.selector);
        pad.claim(id);
    }

    function test_holderRewards_walletToWalletTransferMovesEntitlement() public {
        uint256 id = _create("Move", "MOV", 1, Launchpad.FeeMode.Holders, 0);
        vm.warp(block.timestamp + 500);
        vm.prank(alice);
        pad.buy{value: 10 ether}(id, 0);
        LaunchToken t = _token(id);

        // fee #1 is earned while Alice holds everything
        vm.prank(bob);
        pad.buy{value: 10 ether}(id, 0);
        (uint256 aBefore,) = pad.pending(id, alice);
        assertGt(aBefore, 0);

        // Alice sends ALL her tokens to Carol: her earned rewards stay hers, Carol starts from zero
        uint256 bal = t.balanceOf(alice);
        vm.prank(alice);
        t.transfer(carol, bal);
        (uint256 aAfter,) = pad.pending(id, alice);
        (uint256 cAfter,) = pad.pending(id, carol);
        assertEq(aAfter, aBefore, "history is preserved");
        assertEq(cAfter, 0, "recipient does not inherit past rewards");

        // fee #2 now accrues to Carol, not Alice
        vm.prank(bob);
        pad.buy{value: 10 ether}(id, 0);
        (uint256 aLater,) = pad.pending(id, alice);
        (uint256 cLater,) = pad.pending(id, carol);
        assertEq(aLater, aBefore, "alice no longer earns once she sold out");
        assertGt(cLater, 0);
    }

    function test_holderRewards_sellerStillSharesInOwnSellFee() public {
        uint256 id = _create("Seller", "SEL", 1, Launchpad.FeeMode.Holders, 0);
        vm.warp(block.timestamp + 500);
        vm.prank(alice);
        pad.buy{value: 10 ether}(id, 0);
        vm.prank(bob);
        pad.buy{value: 10 ether}(id, 0);
        // alice exits fully; the sell fee is split over the pre-sell base, so she is credited her share
        LaunchToken t = _token(id);
        uint256 bal = t.balanceOf(alice);
        (uint256 aPre,) = pad.pending(id, alice);
        vm.prank(alice);
        pad.sell(id, bal, 0);
        (uint256 aPost,) = pad.pending(id, alice);
        assertGt(aPost, aPre, "her slice of her own sell fee is credited");
        // and it is claimable even though she holds nothing now
        vm.prank(alice);
        pad.claim(id);
    }

    /* --------------------------------------------------------------- admin */

    function test_ownerCanOnlyWithdrawProtocolFees() public {
        uint256 id = _create("Admin", "ADM", 1, Launchpad.FeeMode.Creator, 0);
        vm.warp(block.timestamp + 500);
        vm.prank(alice);
        pad.buy{value: 100 ether}(id, 0);

        uint256 poolBefore = pad.coinInfo(id).realQuote;
        uint256 creatorBefore = pad.coinInfo(id).creatorFees;
        uint256 owed = pad.protocolFees();
        assertEq(owed, LAUNCH_FEE + 0.5 ether);

        vm.prank(alice);
        vm.expectRevert();
        pad.withdrawProtocolFees(payable(alice));

        address payable treasury = payable(makeAddr("treasury"));
        vm.prank(owner);
        pad.withdrawProtocolFees(treasury);
        assertEq(treasury.balance, owed);
        assertEq(pad.protocolFees(), 0);
        // pool liquidity and creator fees are untouched and still fully backed
        assertEq(pad.coinInfo(id).realQuote, poolBefore);
        assertEq(pad.coinInfo(id).creatorFees, creatorBefore);
        assertGe(address(pad).balance, poolBefore + creatorBefore);

        // a second withdrawal sends nothing
        vm.prank(owner);
        pad.withdrawProtocolFees(treasury);
        assertEq(treasury.balance, owed);
    }

    function test_ownershipIsTwoStep() public {
        vm.prank(owner);
        pad.transferOwnership(alice);
        assertEq(pad.owner(), owner, "not transferred until accepted");
        vm.prank(alice);
        pad.acceptOwnership();
        assertEq(pad.owner(), alice);
    }

    function test_rejectsStrayEther() public {
        (bool ok,) = address(pad).call{value: 1 ether}("");
        assertFalse(ok);
    }

    /* ----------------------------------------------------------- reentrancy */

    function test_reentrancy_onSellPayout() public {
        uint256 id = _create("Reenter", "REN", 1, Launchpad.FeeMode.Holders, 0);
        vm.warp(block.timestamp + 500);
        ReentrantSeller attacker = new ReentrantSeller(pad, id);
        vm.deal(address(attacker), 100 ether);
        attacker.buyIn(10 ether);
        // the payout callback tries to re-enter sell/claim/buy; the guard turns that into a failed transfer
        vm.expectRevert(Launchpad.TransferFailed.selector);
        attacker.sellHalf();
        // state is untouched by the reverted attempt
        assertGt(_token(id).balanceOf(address(attacker)), 0);
    }

    /* ----------------------------------------------------------------- fuzz */

    function testFuzz_roundTripNeverProfits(uint256 amount, uint256 ageSeed) public {
        amount = bound(amount, 0.001 ether, 1_000 ether);
        uint256 id = _create("Fuzz", "FZZ", 1, Launchpad.FeeMode.Creator, 0);
        vm.warp(block.timestamp + 121 + (ageSeed % 100_000)); // outside the early-cap window
        uint256 bal0 = alice.balance;
        vm.startPrank(alice);
        pad.buy{value: amount}(id, 0);
        uint256 tokens = _token(id).balanceOf(alice);
        pad.sell(id, tokens, 0);
        vm.stopPrank();
        assertLe(alice.balance, bal0, "a buy+sell round trip can never be profitable");
        assertGe(bal0 - alice.balance, (amount * 190) / 10_000, "~2% lost to fees");
    }

    function testFuzz_quoteMatchesExecution(uint256 amount, uint256 age) public {
        amount = bound(amount, 0.001 ether, 500 ether);
        age = bound(age, 121, 1 days);
        uint256 id = _create("Quote", "QTE", 2, Launchpad.FeeMode.Creator, 0);
        vm.warp(block.timestamp + age);
        (uint256 q,,) = pad.quoteBuy(id, amount);
        vm.prank(alice);
        pad.buy{value: amount}(id, q);
        assertEq(_token(id).balanceOf(alice), q);
        uint256 tokens = _token(id).balanceOf(alice);
        (uint256 payoutQ,,) = pad.quoteSell(id, tokens);
        uint256 before = alice.balance;
        vm.prank(alice);
        pad.sell(id, tokens, payoutQ);
        assertEq(alice.balance - before, payoutQ);
    }

    function testFuzz_priceMonotonic(uint256 a, uint256 b) public {
        a = bound(a, 0.01 ether, 200 ether);
        b = bound(b, 0.01 ether, 200 ether);
        uint256 id = _create("Mono", "MNO", 1, Launchpad.FeeMode.Creator, 0);
        vm.warp(block.timestamp + 500);
        vm.prank(alice);
        pad.buy{value: a}(id, 0);
        Launchpad.Coin memory c1 = pad.coinInfo(id);
        vm.prank(bob);
        pad.buy{value: b}(id, 0);
        Launchpad.Coin memory c2 = pad.coinInfo(id);
        // price = vq/vt must rise on every buy
        assertGt(c2.vq * c1.vt, c1.vq * c2.vt);
    }
}

/// @dev Seller that tries to re-enter the launchpad from its receive hook.
contract ReentrantSeller {
    Launchpad immutable pad;
    uint256 immutable id;

    constructor(Launchpad pad_, uint256 id_) {
        pad = pad_;
        id = id_;
    }

    function buyIn(uint256 amt) external {
        pad.buy{value: amt}(id, 0);
    }

    /// @dev sells HALF, so there is still a balance left to try to re-enter with in the payout callback
    function sellHalf() external {
        uint256 bal = pad.coinInfo(id).token.balanceOf(address(this));
        pad.sell(id, bal / 2, 0);
    }

    receive() external payable {
        // try every state-changing entry point
        try pad.claim(id) {} catch {}
        try pad.buy{value: 1 ether}(id, 0) {} catch {}
        // the one that matters: a second sell mid-payout. It must not succeed; bubble its failure up.
        uint256 bal = pad.coinInfo(id).token.balanceOf(address(this));
        if (bal > 0) pad.sell(id, bal, 0);
    }
}
