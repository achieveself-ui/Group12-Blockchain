// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PoolShareToken} from "./PoolShareToken.sol";

/// @notice DANGEROUS LOCAL TEACHING MODEL. Never deploy to a public network.
/// @dev Deliberate bugs: stale cache; unchecked wrong subtraction; public reinitialization.
/// This is NOT a reconstruction of a real protocol or incident.
contract VulnerablePool is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    IERC20 public assetToken;
    PoolShareToken public shareToken;
    bool public initialized;
    uint256 public cachedPoolBalance;
    error LocalOnly();
    error InvalidToken();
    error NotInitialized();
    error ZeroAmount();
    error InsufficientShares();
    event Initialized(address indexed assetToken, address indexed shareToken);
    event Deposited(address indexed user, uint256 assets, uint256 shares);
    event Redeemed(address indexed user, uint256 shares, uint256 assets);

    constructor() Ownable(msg.sender) { _localOnly(); }
    function _localOnly() private view {
        if (block.chainid != 31337) revert LocalOnly();
    }
    modifier localReady() {
        _localOnly();
        if (!initialized) revert NotInitialized();
        _;
    }

    // INTENTIONAL BUG: no owner check, no one-time guard.
    function initialize(address assetToken_, address shareToken_) external {
        _localOnly();
        if (assetToken_ == shareToken_ || assetToken_.code.length == 0 || shareToken_.code.length == 0)
            revert InvalidToken();
        if (PoolShareToken(shareToken_).pool() != address(this)) revert InvalidToken();
        assetToken = IERC20(assetToken_);
        shareToken = PoolShareToken(shareToken_);
        initialized = true;
        cachedPoolBalance = 0;
        emit Initialized(assetToken_, shareToken_);
    }

    function deposit(uint256 assets) external localReady whenNotPaused nonReentrant {
        if (assets == 0) revert ZeroAmount();
        uint256 shares = assets;
        if (shareToken.totalSupply() != 0 && cachedPoolBalance > getPoolBalance()) {
            // INTENTIONAL BUG: use stale total balance as a subtraction from new input,
            // and suppress the underflow check. Neither operation is valid accounting.
            unchecked { shares = assets - cachedPoolBalance; }
        }
        assetToken.safeTransferFrom(msg.sender, address(this), assets);
        shareToken.mint(msg.sender, shares);
        cachedPoolBalance += assets;
        emit Deposited(msg.sender, assets, shares);
    }

    function redeem(uint256 shares) external localReady whenNotPaused nonReentrant {
        if (shares == 0) revert ZeroAmount();
        if (shareToken.balanceOf(msg.sender) < shares) revert InsufficientShares();
        uint256 assets = Math.mulDiv(shares, getPoolBalance(), shareToken.totalSupply());
        shareToken.burn(msg.sender, shares);
        // INTENTIONAL BUG: cachedPoolBalance is never decreased on redemption.
        assetToken.safeTransfer(msg.sender, assets);
        emit Redeemed(msg.sender, shares, assets);
    }

    function getPoolBalance() public view returns (uint256) {
        return initialized ? assetToken.balanceOf(address(this)) : 0;
    }
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
