// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PoolShareToken} from "./PoolShareToken.sol";

/// @notice Fixed 1:1 in base units. Intended asset: this project's non-rebasing TestToken.
/// @dev Address/metadata checks do NOT certify arbitrary token or share implementations.
contract SecurePool is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    IERC20 public assetToken;
    PoolShareToken public shareToken;
    bool public initialized;

    error AlreadyInitialized();
    error NotInitialized();
    error InvalidToken();
    error InvalidShareToken();
    error UnsupportedDecimals();
    error ZeroAmount();
    error InsufficientShares();
    error InsufficientPoolAssets();
    error UnsupportedAssetTransfer();
    error InsufficientBacking();

    event Initialized(address indexed assetToken, address indexed shareToken);
    event Deposited(address indexed user, uint256 assets, uint256 shares);
    event Redeemed(address indexed user, uint256 shares, uint256 assets);

    constructor() Ownable(msg.sender) {}

    function initialize(address assetToken_, address shareToken_) external onlyOwner {
        if (initialized) revert AlreadyInitialized();
        if (assetToken_ == shareToken_ || assetToken_.code.length == 0 || shareToken_.code.length == 0)
            revert InvalidToken();
        PoolShareToken receipt = PoolShareToken(shareToken_);
        if (receipt.pool() != address(this) || receipt.totalSupply() != 0) revert InvalidShareToken();
        if (IERC20Metadata(assetToken_).decimals() != 18 || receipt.decimals() != 18)
            revert UnsupportedDecimals();
        assetToken = IERC20(assetToken_);
        shareToken = receipt;
        initialized = true;
        emit Initialized(assetToken_, shareToken_);
    }

    modifier ready() {
        if (!initialized) revert NotInitialized();
        _;
    }

    function deposit(uint256 assets) external ready whenNotPaused nonReentrant {
        if (assets == 0) revert ZeroAmount();
        uint256 beforeBalance = getPoolBalance();
        uint256 userBefore = assetToken.balanceOf(msg.sender);
        _checkBacking(beforeBalance);
        assetToken.safeTransferFrom(msg.sender, address(this), assets);
        uint256 afterBalance = getPoolBalance();
        uint256 userAfter = assetToken.balanceOf(msg.sender);
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != assets ||
            userBefore < userAfter || userBefore - userAfter != assets) revert UnsupportedAssetTransfer();
        shareToken.mint(msg.sender, assets);
        _checkBacking(afterBalance);
        emit Deposited(msg.sender, assets, assets);
    }

    function redeem(uint256 shares) external ready whenNotPaused nonReentrant {
        if (shares == 0) revert ZeroAmount();
        if (shareToken.balanceOf(msg.sender) < shares) revert InsufficientShares();
        uint256 beforeBalance = getPoolBalance();
        if (beforeBalance < shares) revert InsufficientPoolAssets();
        _checkBacking(beforeBalance);
        uint256 userBefore = assetToken.balanceOf(msg.sender);
        shareToken.burn(msg.sender, shares);
        assetToken.safeTransfer(msg.sender, shares);
        uint256 afterBalance = getPoolBalance();
        uint256 userAfter = assetToken.balanceOf(msg.sender);
        if (afterBalance > beforeBalance || beforeBalance - afterBalance != shares ||
            userAfter < userBefore || userAfter - userBefore != shares) revert UnsupportedAssetTransfer();
        _checkBacking(afterBalance);
        emit Redeemed(msg.sender, shares, shares);
    }

    function getPoolBalance() public view returns (uint256) {
        return initialized ? assetToken.balanceOf(address(this)) : 0;
    }

    function _checkBacking(uint256 assets) private view {
        if (assets < shareToken.totalSupply()) revert InsufficientBacking();
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
