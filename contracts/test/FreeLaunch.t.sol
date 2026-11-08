// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Launchpad} from "../src/Launchpad.sol";

/// The shipped deploy script defaults to a launch fee of 0 (launching is free). Every other suite deploys with a
/// non-zero fee, so this one pins the zero-fee behaviour explicitly.
contract FreeLaunchTest is Test {
    Launchpad pad;
    address owner = makeAddr("owner");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");

    function setUp() public {
        uint256[] memory tiers = new uint256[](2);
        tiers[0] = 400 ether;
        tiers[1] = 800 ether;
        pad = new Launchpad(owner, 0, tiers);
        vm.warp(1_700_000_000);
        vm.deal(creator, 1_000 ether);
        vm.deal(alice, 1_000 ether);
    }

    function _p(string memory n, string memory s, uint256 firstBuy) internal pure returns (Launchpad.CreateParams memory) {
        return Launchpad.CreateParams(n, s, "", 0, Launchpad.FeeMode.Creator, firstBuy);
    }

    function test_launchIsFree() public {
        assertEq(pad.launchFee(), 0);
        vm.prank(creator);
        uint256 id = pad.createCoin(_p("Free Coin", "FREE", 0)); // no value sent at all
        assertEq(id, 1);
        assertEq(pad.protocolFees(), 0, "nothing was charged");
        assertEq(address(pad).balance, 0);
        assertEq(pad.coinInfo(id).sold, 0);
    }

    function test_freeLaunch_stillRejectsStrayPayment() public {
        // with no first buy the payment must be exactly zero: accidental ETH is refused, never swallowed
        vm.prank(creator);
        vm.expectRevert(Launchpad.WrongPayment.selector);
        pad.createCoin{value: 1 ether}(_p("Free Coin", "FREE", 0));
    }

    function test_freeLaunch_firstBuyStillWorks() public {
        vm.prank(creator);
        uint256 id = pad.createCoin{value: 10 ether}(_p("Free Coin", "FREE", 10 ether));
        Launchpad.Coin memory c = pad.coinInfo(id);
        assertGt(c.token.balanceOf(creator), 0);
        // only the trading fee exists: 1% of 10 = 0.1 (half creator, half protocol)
        assertEq(c.creatorFees, 0.05 ether);
        assertEq(pad.protocolFees(), 0.05 ether);
    }

    function test_freeLaunch_tradingFeesStillFlow() public {
        vm.prank(creator);
        uint256 id = pad.createCoin(_p("Free Coin", "FREE", 0));
        vm.warp(block.timestamp + 500);
        vm.prank(alice);
        pad.buy{value: 100 ether}(id, 0);
        // revenue comes from trading, not from launching
        assertEq(pad.coinInfo(id).creatorFees, 0.5 ether);
        assertEq(pad.protocolFees(), 0.5 ether);
        vm.prank(owner);
        pad.withdrawProtocolFees(payable(owner));
        assertEq(owner.balance, 0.5 ether);
    }

    function test_freeLaunch_antiVampStillBlocksCopies() public {
        vm.prank(creator);
        pad.createCoin(_p("Free Coin", "FREE", 0));
        vm.prank(alice);
        vm.expectRevert(Launchpad.AntiVamp.selector);
        pad.createCoin(_p("free coin", "free", 0));
    }
}
