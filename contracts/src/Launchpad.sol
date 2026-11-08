// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {LaunchToken, ILaunchpadHooks} from "./LaunchToken.sol";

/**
 * @title Launchpad
 * @notice Permissionless token launchpad with locked liquidity. Anyone can create a coin; the native gas asset
 *         (HYPE on HyperEVM) is the quote asset.
 *
 *  - Each coin is a fixed-supply {LaunchToken}. The whole supply is minted into this contract and priced by a
 *    constant-product curve with a virtual quote reserve (the "start market cap"). There is no LP token, no
 *    withdrawal path for pool liquidity, and no admin function that can touch it.
 *  - Every trade pays a 1% fee: 0.5% to the protocol and 0.5% either to the creator or shared pro-rata with every
 *    holder (chosen at launch, permanent).
 *  - Launch protection: a dynamic anti-snipe surcharge and an early per-wallet cap, both decaying over two minutes.
 *  - AntiVamp: a name + ticker pair can only be used once.
 *
 *  The owner can do exactly one thing: withdraw accrued protocol fees. The market maths mirror shared/market.ts in
 *  the web app and are covered by fixed-vector tests.
 *
 *  NOT AUDITED. Do not deploy to a network holding real value until it has been independently reviewed.
 */
contract Launchpad is Ownable2Step, ReentrancyGuard, ILaunchpadHooks {
    /* ---------------------------------------------------------------- types */

    enum FeeMode {
        Creator, // 0.5% of every trade accrues to the creator
        Holders // 0.5% of every trade is shared with all holders
    }

    struct Coin {
        LaunchToken token;
        address creator;
        uint64 createdAt;
        FeeMode feeMode;
        uint256 startMcap; // initial virtual quote reserve (wei)
        uint256 vq; // virtual quote reserve (wei)
        uint256 vt; // virtual token reserve (token units, 6 decimals)
        uint256 realQuote; // quote actually held for this coin's pool (wei)
        uint256 sold; // tokens held outside the pool
        uint256 rewardIndex; // wei per token unit, scaled by 1e18 (holder-reward mode)
        uint256 creatorFees; // unclaimed creator fees (wei)
        uint256 holderFeesTotal; // fees distributed to holders so far (wei)
        uint256 holderClaimed; // part of holderFeesTotal already withdrawn (wei)
    }

    /// @dev Grouped into one calldata struct so the creation flow stays within the EVM stack limit.
    struct CreateParams {
        string name;
        string symbol;
        string metadataURI;
        uint8 tier; // index into startMcapTiers()
        FeeMode mode;
        uint256 firstBuy; // gross quote for the creator's launch buy (0 = none)
    }

    struct Holder {
        uint256 snapshot; // rewardIndex at last settlement
        uint256 pending; // settled, unclaimed rewards (wei)
        uint256 claimed; // lifetime claimed (wei)
    }

    /* ------------------------------------------------------------ constants */

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 * 1e6;
    uint256 public constant BPS = 10_000;
    uint256 public constant BASE_FEE_BPS = 100; // 1% per trade
    uint256 public constant CREATOR_FEE_BPS = 50; // half of the base fee
    uint256 public constant SNIPE_START_BPS = 2000; // extra 20% at second 0 ...
    uint256 public constant SNIPE_DURATION = 120; // ... decaying linearly to 0 over 120s
    uint256 public constant WALLET_CAP_BPS = 150; // 1.5% of supply per non-creator wallet ...
    uint256 public constant WALLET_CAP_DURATION = 120; // ... for the first 120s
    uint256 public constant MAX_CREATOR_BUY_BPS = 2000; // launch buy capped at 20% of supply
    uint256 private constant INDEX_SCALE = 1e18;

    /* -------------------------------------------------------------- storage */

    uint256 public immutable launchFee;
    uint256[] private _tiers;

    uint256 public coinCount;
    uint256 public protocolFees; // accrued, withdrawable by the owner
    mapping(uint256 => Coin) private _coins;
    mapping(uint256 => mapping(address => Holder)) private _holders;
    mapping(bytes32 => bool) public identityTaken;

    /* --------------------------------------------------------------- events */

    event CoinCreated(
        uint256 indexed id,
        address indexed creator,
        address token,
        string name,
        string symbol,
        string metadataURI,
        FeeMode feeMode,
        uint256 startMcap,
        uint256 createdAt
    );
    event Trade(
        uint256 indexed id,
        address indexed trader,
        bool isBuy,
        uint256 quoteAmount, // buy: gross paid in; sell: gross out before fee
        uint256 tokenAmount,
        uint256 fee,
        uint256 vq,
        uint256 vt,
        uint256 realQuote,
        uint256 sold,
        uint256 timestamp
    );
    event BalanceChanged(uint256 indexed id, address indexed account, uint256 balance);
    event Claimed(uint256 indexed id, address indexed account, uint256 creatorAmount, uint256 holderAmount);
    event ProtocolFeesWithdrawn(address indexed to, uint256 amount);

    /* --------------------------------------------------------------- errors */

    error WrongPayment();
    error BadTier();
    error BadName();
    error BadSymbol();
    error BadMetadata();
    error AntiVamp();
    error UnknownCoin();
    error AmountTooSmall();
    error Slippage();
    error InsufficientBalance();
    error InsufficientLiquidity();
    error LaunchBuyTooLarge();
    error EarlyWalletLimit();
    error NothingToClaim();
    error NotToken();
    error TransferFailed();

    /* ---------------------------------------------------------- constructor */

    constructor(address owner_, uint256 launchFee_, uint256[] memory tiers_) Ownable(owner_) {
        require(tiers_.length > 0 && tiers_.length <= 8, "tiers");
        for (uint256 i = 0; i < tiers_.length; i++) {
            require(tiers_[i] > 0, "tier=0");
            _tiers.push(tiers_[i]);
        }
        launchFee = launchFee_;
    }

    /* -------------------------------------------------------------- launch */

    /**
     * @notice Create a coin and optionally buy a first stake in the same transaction.
     * @dev msg.value must equal `launchFee + p.firstBuy` exactly. The launch buy is capped at 20% of supply and
     *      pays only the base fee (no anti-snipe surcharge).
     */
    function createCoin(CreateParams calldata p) external payable nonReentrant returns (uint256 id) {
        if (msg.value != launchFee + p.firstBuy) revert WrongPayment();
        if (p.tier >= _tiers.length) revert BadTier();
        _validate(p);

        bytes32 key = keccak256(abi.encode(_lower(bytes(p.name)), _lower(bytes(p.symbol))));
        if (identityTaken[key]) revert AntiVamp();
        identityTaken[key] = true;

        id = ++coinCount;
        LaunchToken token = new LaunchToken(p.name, p.symbol, id);

        Coin storage c = _coins[id];
        c.token = token;
        c.creator = msg.sender;
        c.createdAt = uint64(block.timestamp);
        c.feeMode = p.mode;
        c.startMcap = _tiers[p.tier];
        c.vq = _tiers[p.tier];
        c.vt = TOTAL_SUPPLY;
        protocolFees += launchFee;

        emit CoinCreated(id, msg.sender, address(token), p.name, p.symbol, p.metadataURI, p.mode, c.startMcap, block.timestamp);

        if (p.firstBuy > 0) _buy(id, c, msg.sender, p.firstBuy, 0, true);
    }

    /* ------------------------------------------------------------- trading */

    /// @notice Buy with the native asset sent as msg.value. Reverts if fewer than `minTokensOut` would be received.
    function buy(uint256 id, uint256 minTokensOut) external payable nonReentrant {
        _buy(id, _coin(id), msg.sender, msg.value, minTokensOut, false);
    }

    /// @notice Sell tokens back to the pool. No approval is needed. Reverts if the payout is below `minQuoteOut`.
    function sell(uint256 id, uint256 tokens, uint256 minQuoteOut) external nonReentrant {
        Coin storage c = _coin(id);
        if (tokens == 0) revert AmountTooSmall();
        if (tokens > c.token.balanceOf(msg.sender)) revert InsufficientBalance();

        uint256 bps = _feeBps(c);
        uint256 gross = (c.vq * tokens) / (c.vt + tokens);
        if (gross == 0) revert AmountTooSmall();
        if (gross > c.realQuote) revert InsufficientLiquidity();
        uint256 fee = (gross * bps) / BPS;
        uint256 payout = gross - fee;
        if (payout < minQuoteOut) revert Slippage();

        (uint256 creatorFee, uint256 protocolFee) = _split(fee, gross, bps);
        _routeCreatorFee(c, creatorFee);
        protocolFees += protocolFee;
        // the fee above was split over the pre-sell holder base, so settle the seller before their balance shrinks
        _settle(id, c, msg.sender);

        c.vq -= gross;
        c.vt += tokens;
        c.realQuote -= gross;
        c.sold -= tokens;
        c.token.pullFrom(msg.sender, tokens);

        _emitTrade(id, c, msg.sender, false, gross, tokens, fee);

        (bool ok,) = msg.sender.call{value: payout}("");
        if (!ok) revert TransferFailed();
    }

    function _buy(uint256 id, Coin storage c, address trader, uint256 gross, uint256 minOut, bool launchBuy) internal {
        uint256 bps = launchBuy ? BASE_FEE_BPS : _feeBps(c);
        uint256 fee = (gross * bps) / BPS;
        uint256 net = gross - fee;
        uint256 out = (c.vt * net) / (c.vq + net);
        if (out == 0) revert AmountTooSmall();
        if (out < minOut) revert Slippage();

        uint256 bal = c.token.balanceOf(trader);
        if (launchBuy) {
            if ((bal + out) * BPS > TOTAL_SUPPLY * MAX_CREATOR_BUY_BPS) revert LaunchBuyTooLarge();
        } else if (trader != c.creator) {
            uint256 limit = _walletLimit(c);
            if (limit != 0 && bal + out > limit) revert EarlyWalletLimit();
        }

        (uint256 creatorFee, uint256 protocolFee) = _split(fee, gross, bps);
        // Fee first (split over the PRE-trade holder base), then settle the buyer on their PRE-trade balance,
        // and only then hand over the new tokens, so fresh tokens never earn a cut of their own purchase fee.
        _routeCreatorFee(c, creatorFee);
        protocolFees += protocolFee;
        _settle(id, c, trader);

        c.vq += net;
        c.vt -= out;
        c.realQuote += net;
        c.sold += out;
        // plain ERC-20 transfer from this contract: the token calls our before/after hooks
        require(c.token.transfer(trader, out), "transfer");

        _emitTrade(id, c, trader, true, gross, out, fee);
    }

    /* ------------------------------------------------------------- rewards */

    /// @notice Withdraw creator fees (if you are the creator) and holder rewards (if you hold the coin).
    function claim(uint256 id) external nonReentrant {
        Coin storage c = _coin(id);
        uint256 creatorAmount;
        if (msg.sender == c.creator && c.creatorFees > 0) {
            creatorAmount = c.creatorFees;
            c.creatorFees = 0;
        }
        _settle(id, c, msg.sender);
        Holder storage h = _holders[id][msg.sender];
        uint256 holderAmount = h.pending;
        if (holderAmount > 0) {
            h.pending = 0;
            h.claimed += holderAmount;
            c.holderClaimed += holderAmount;
        }
        uint256 total = creatorAmount + holderAmount;
        if (total == 0) revert NothingToClaim();
        emit Claimed(id, msg.sender, creatorAmount, holderAmount);
        (bool ok,) = msg.sender.call{value: total}("");
        if (!ok) revert TransferFailed();
    }

    function _routeCreatorFee(Coin storage c, uint256 creatorFee) internal {
        if (creatorFee == 0) return;
        if (c.feeMode == FeeMode.Holders) {
            if (c.sold > 0) {
                // The whole fee is booked as collected-for-holders. Each holder's share is floor(balance * index
                // delta), and the sum of those shares can never exceed the fee (delta is rounded DOWN), so holders
                // can never be credited more than was collected. The sub-wei rounding dust simply stays reserved
                // in the contract. (Booking only the rounded-down amount instead lets many small roundings add up
                // to more owed than "collected", which the invariant tests caught.)
                c.rewardIndex += (creatorFee * INDEX_SCALE) / c.sold;
                c.holderFeesTotal += creatorFee;
            } else {
                protocolFees += creatorFee;
            }
        } else {
            c.creatorFees += creatorFee;
        }
    }

    function _settle(uint256 id, Coin storage c, address account) internal {
        Holder storage h = _holders[id][account];
        uint256 idx = c.rewardIndex;
        if (idx > h.snapshot) {
            uint256 bal = c.token.balanceOf(account);
            if (bal > 0) h.pending += (bal * (idx - h.snapshot)) / INDEX_SCALE;
        }
        h.snapshot = idx;
    }

    /* --------------------------------------------------------------- hooks */

    function beforeTokenTransfer(uint256 id, address from, address to) external override {
        Coin storage c = _coins[id];
        if (msg.sender != address(c.token)) revert NotToken();
        if (from != address(this)) _settle(id, c, from);
        if (to != address(this)) _settle(id, c, to);
    }

    function afterTokenTransfer(uint256 id, address from, address to) external override {
        Coin storage c = _coins[id];
        if (msg.sender != address(c.token)) revert NotToken();
        if (from != address(this)) emit BalanceChanged(id, from, c.token.balanceOf(from));
        if (to != address(this) && to != from) emit BalanceChanged(id, to, c.token.balanceOf(to));
    }

    /* --------------------------------------------------------------- admin */

    /// @notice The only privileged action: sweep accrued protocol fees. Pool liquidity, creator fees and holder
    ///         rewards are tracked separately and cannot be reached from here.
    function withdrawProtocolFees(address payable to) external onlyOwner nonReentrant {
        uint256 amount = protocolFees;
        protocolFees = 0;
        emit ProtocolFeesWithdrawn(to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /* --------------------------------------------------------------- views */

    function startMcapTiers() external view returns (uint256[] memory) {
        return _tiers;
    }

    function coinInfo(uint256 id) external view returns (Coin memory) {
        return _coin(id);
    }

    /// @notice Current total fee in bps for a coin (base fee plus any decaying anti-snipe surcharge).
    function currentFeeBps(uint256 id) external view returns (uint256) {
        return _feeBps(_coin(id));
    }

    function quoteBuy(uint256 id, uint256 gross) external view returns (uint256 tokensOut, uint256 fee, uint256 feeBps) {
        Coin storage c = _coin(id);
        feeBps = _feeBps(c);
        fee = (gross * feeBps) / BPS;
        uint256 net = gross - fee;
        tokensOut = (c.vt * net) / (c.vq + net);
    }

    function quoteSell(uint256 id, uint256 tokens) external view returns (uint256 payout, uint256 fee, uint256 feeBps) {
        Coin storage c = _coin(id);
        feeBps = _feeBps(c);
        uint256 gross = (c.vq * tokens) / (c.vt + tokens);
        fee = (gross * feeBps) / BPS;
        payout = gross - fee;
    }

    /// @notice Claimable amounts for `account`: (holder rewards, creator fees).
    function pending(uint256 id, address account) external view returns (uint256 holderAmount, uint256 creatorAmount) {
        Coin storage c = _coin(id);
        Holder storage h = _holders[id][account];
        holderAmount = h.pending;
        if (c.rewardIndex > h.snapshot) {
            holderAmount += (c.token.balanceOf(account) * (c.rewardIndex - h.snapshot)) / INDEX_SCALE;
        }
        if (account == c.creator) creatorAmount = c.creatorFees;
    }

    function holderInfo(uint256 id, address account) external view returns (Holder memory) {
        return _holders[id][account];
    }

    /// @notice Max tokens a non-creator wallet may hold right now, or 0 when no limit applies.
    function walletLimit(uint256 id) external view returns (uint256) {
        return _walletLimit(_coin(id));
    }

    /* ------------------------------------------------------------ internals */

    function _emitTrade(uint256 id, Coin storage c, address trader, bool isBuy, uint256 quoteAmount, uint256 tokenAmount, uint256 fee)
        internal
    {
        emit Trade(id, trader, isBuy, quoteAmount, tokenAmount, fee, c.vq, c.vt, c.realQuote, c.sold, block.timestamp);
    }

    function _coin(uint256 id) internal view returns (Coin storage c) {
        c = _coins[id];
        if (address(c.token) == address(0)) revert UnknownCoin();
    }

    function _feeBps(Coin storage c) internal view returns (uint256) {
        uint256 age = block.timestamp - c.createdAt;
        if (age >= SNIPE_DURATION) return BASE_FEE_BPS;
        return BASE_FEE_BPS + (SNIPE_START_BPS * (SNIPE_DURATION - age)) / SNIPE_DURATION;
    }

    function _walletLimit(Coin storage c) internal view returns (uint256) {
        if (block.timestamp - c.createdAt >= WALLET_CAP_DURATION) return 0;
        return (TOTAL_SUPPLY * WALLET_CAP_BPS) / BPS;
    }

    function _split(uint256 fee, uint256 amount, uint256 totalBps) internal pure returns (uint256 creatorFee, uint256 protocolFee) {
        uint256 cb = CREATOR_FEE_BPS < totalBps ? CREATOR_FEE_BPS : totalBps;
        creatorFee = (amount * cb) / BPS;
        if (creatorFee > fee) creatorFee = fee;
        protocolFee = fee - creatorFee;
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
