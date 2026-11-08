// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title V4Token
 * @notice Fixed-supply ERC-20 (1,000,000,000 tokens, 6 decimals) for coins that trade on a Uniswap v4 pool.
 *         The whole supply is minted to the launchpad, which seeds it into the pool in the same transaction.
 *         There is no owner, no mint, no burn, no pause, no blacklist and no transfer hook: it is a plain ERC-20,
 *         so Uniswap's routers, aggregators and wallets treat it like any other token.
 *
 *         The one extra function, {pullFrom}, lets the launchpad take tokens from a seller who called
 *         `sell` on it (so selling needs no approval transaction). The launchpad only ever passes the caller.
 */
contract V4Token is ERC20 {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 * 1e6;

    address public immutable launchpad;
    uint256 public immutable coinId;

    error OnlyLaunchpad();

    constructor(string memory name_, string memory symbol_, uint256 coinId_) ERC20(name_, symbol_) {
        launchpad = msg.sender;
        coinId = coinId_;
        _mint(msg.sender, TOTAL_SUPPLY);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Used only by the launchpad's `sell`, with `from` being the seller who made that call.
    function pullFrom(address from, uint256 amount) external {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        _transfer(from, launchpad, amount);
    }
}
