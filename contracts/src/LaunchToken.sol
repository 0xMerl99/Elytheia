// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev The few Launchpad hooks a token needs, kept as an interface so the token never imports the pad.
interface ILaunchpadHooks {
    function beforeTokenTransfer(uint256 id, address from, address to) external;
    function afterTokenTransfer(uint256 id, address from, address to) external;
}

/**
 * @title LaunchToken
 * @notice Fixed-supply ERC-20 (1,000,000,000 tokens, 6 decimals). The whole supply is minted to the Launchpad,
 *         which is the only liquidity venue: there is no owner, no mint, no burn, no pause and no blacklist.
 *
 *         Every transfer notifies the Launchpad (before and after) so holder rewards are settled against the
 *         correct balance, and so the indexer sees exact balances. Tokens cannot be sent *to* the Launchpad by a
 *         plain transfer (they would be lost to the pool); selling goes through {pullFrom}.
 */
contract LaunchToken is ERC20 {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 * 1e6;

    address public immutable launchpad;
    uint256 public immutable coinId;

    bool private _pulling;

    error OnlyLaunchpad();
    error DirectTransferToPool();

    constructor(string memory name_, string memory symbol_, uint256 coinId_) ERC20(name_, symbol_) {
        launchpad = msg.sender;
        coinId = coinId_;
        _mint(msg.sender, TOTAL_SUPPLY);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Used by the Launchpad to take tokens from a seller without an approval round-trip.
    /// @dev Only ever called with `from == <the seller who called Launchpad.sell>`.
    function pullFrom(address from, uint256 amount) external {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        _pulling = true;
        _update(from, launchpad, amount);
        _pulling = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        // minting happens in the constructor, before the Launchpad has registered this coin
        bool isMint = from == address(0);
        if (!isMint) {
            if (to == launchpad && !_pulling) revert DirectTransferToPool();
            ILaunchpadHooks(launchpad).beforeTokenTransfer(coinId, from, to);
        }
        super._update(from, to, value);
        if (!isMint) ILaunchpadHooks(launchpad).afterTokenTransfer(coinId, from, to);
    }
}
