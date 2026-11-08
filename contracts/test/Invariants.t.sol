// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchToken} from "../src/LaunchToken.sol";

/// @dev Drives random sequences of trades, transfers, claims and time jumps against two coins (one per reward mode).
contract Handler is Test {
    Launchpad public pad;
    uint256 public holdersCoin;
    uint256 public creatorCoin;
    address[] public actors;
    address public creator;

    uint256 public ghostClaimed;
    uint256 public calls;

    constructor(Launchpad pad_, address creator_) {
        pad = pad_;
        creator = creator_;
        for (uint256 i = 0; i < 5; i++) {
            address a = address(uint160(0xA11CE + i));
            actors.push(a);
            vm.deal(a, 1_000_000 ether);
        }
        vm.deal(creator_, 1_000_000 ether);
        vm.startPrank(creator_);
        holdersCoin = pad.createCoin{value: 0.5 ether}(
            Launchpad.CreateParams("Holders", "HLD", "", 1, Launchpad.FeeMode.Holders, 0)
        );
        creatorCoin = pad.createCoin{value: 0.5 ether}(
            Launchpad.CreateParams("Creator", "CRT", "", 0, Launchpad.FeeMode.Creator, 0)
        );
        vm.stopPrank();
    }

    function _coin(uint256 seed) internal view returns (uint256) {
        return seed % 2 == 0 ? holdersCoin : creatorCoin;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function buy(uint256 coinSeed, uint256 actorSeed, uint256 amount) external {
        calls++;
        uint256 id = _coin(coinSeed);
        address a = _actor(actorSeed);
        amount = bound(amount, 0.001 ether, 300 ether);
        vm.prank(a);
        try pad.buy{value: amount}(id, 0) {} catch {}
    }

    function sell(uint256 coinSeed, uint256 actorSeed, uint256 pct) external {
        calls++;
        uint256 id = _coin(coinSeed);
        address a = _actor(actorSeed);
        LaunchToken t = pad.coinInfo(id).token;
        uint256 bal = t.balanceOf(a);
        if (bal == 0) return;
        uint256 amt = (bal * bound(pct, 1, 100)) / 100;
        if (amt == 0) return;
        vm.prank(a);
        try pad.sell(id, amt, 0) {} catch {}
    }

    function transferTokens(uint256 coinSeed, uint256 fromSeed, uint256 toSeed, uint256 pct) external {
        calls++;
        uint256 id = _coin(coinSeed);
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        LaunchToken t = pad.coinInfo(id).token;
        uint256 bal = t.balanceOf(from);
        if (bal == 0) return;
        uint256 amt = (bal * bound(pct, 1, 100)) / 100;
        vm.prank(from);
        try t.transfer(to, amt) {} catch {}
    }

    function claim(uint256 coinSeed, uint256 actorSeed) external {
        calls++;
        uint256 id = _coin(coinSeed);
        address a = actorSeed % 6 == 5 ? creator : _actor(actorSeed);
        uint256 before = a.balance;
        vm.prank(a);
        try pad.claim(id) {
            ghostClaimed += a.balance - before;
        } catch {}
    }

    function warp(uint256 secs) external {
        calls++;
        vm.warp(block.timestamp + bound(secs, 1, 3 days));
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }
}

contract LaunchpadInvariantTest is Test {
    Launchpad pad;
    Handler handler;
    address owner = makeAddr("owner");
    address creator = makeAddr("creator");

    function setUp() public {
        uint256[] memory tiers = new uint256[](2);
        tiers[0] = 400 ether;
        tiers[1] = 800 ether;
        pad = new Launchpad(owner, 0.5 ether, tiers);
        vm.warp(1_700_000_000);
        handler = new Handler(pad, creator);
        targetContract(address(handler));
        // fuzz only the handler's action functions
        bytes4[] memory sel = new bytes4[](5);
        sel[0] = Handler.buy.selector;
        sel[1] = Handler.sell.selector;
        sel[2] = Handler.transferTokens.selector;
        sel[3] = Handler.claim.selector;
        sel[4] = Handler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    function _all() internal view returns (address[] memory list) {
        uint256 n = handler.actorCount();
        list = new address[](n + 1);
        for (uint256 i = 0; i < n; i++) list[i] = handler.actors(i);
        list[n] = creator;
    }

    /// The contract can always pay every liability it has recorded.
    function invariant_solvency() public view {
        uint256 liabilities = pad.protocolFees();
        for (uint256 id = 1; id <= pad.coinCount(); id++) {
            Launchpad.Coin memory c = pad.coinInfo(id);
            liabilities += c.realQuote + c.creatorFees + (c.holderFeesTotal - c.holderClaimed);
        }
        assertGe(address(pad).balance, liabilities, "balance must cover pool + creator fees + unclaimed holder rewards + protocol fees");
    }

    /// `sold` is exactly the supply outside the pool, and circulating balances add up to it.
    function invariant_supplyAccounting() public view {
        address[] memory list = _all();
        for (uint256 id = 1; id <= pad.coinCount(); id++) {
            Launchpad.Coin memory c = pad.coinInfo(id);
            assertEq(c.sold, c.token.totalSupply() - c.token.balanceOf(address(pad)), "sold == supply outside pool");
            uint256 sum;
            for (uint256 i = 0; i < list.length; i++) sum += c.token.balanceOf(list[i]);
            assertEq(sum, c.sold, "holder balances sum to circulating supply");
        }
    }

    /// Holders can never be credited more than was collected for them.
    function invariant_rewardsConserved() public view {
        address[] memory list = _all();
        for (uint256 id = 1; id <= pad.coinCount(); id++) {
            Launchpad.Coin memory c = pad.coinInfo(id);
            uint256 owed;
            for (uint256 i = 0; i < list.length; i++) {
                (uint256 h,) = pad.pending(id, list[i]);
                owed += h;
            }
            assertLe(owed, c.holderFeesTotal - c.holderClaimed, "unclaimed holder rewards <= collected-and-unclaimed");
        }
    }

    /// The price curve's reserves stay consistent with the real quote held (no value can leak out of the pool).
    function invariant_poolReserves() public view {
        for (uint256 id = 1; id <= pad.coinCount(); id++) {
            Launchpad.Coin memory c = pad.coinInfo(id);
            assertEq(c.vq, c.startMcap + c.realQuote, "virtual quote = start mcap + real quote");
            assertEq(c.vt, c.token.balanceOf(address(pad)), "virtual tokens = tokens left in the pool");
        }
    }
}
