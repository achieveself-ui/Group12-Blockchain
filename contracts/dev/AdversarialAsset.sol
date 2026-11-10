// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {TestToken} from "../TestToken.sol";

/// @notice TEST ONLY. Never use this asset in deployment. Deliberate test controls.
contract AdversarialAsset is TestToken {
    uint8 public mode;
    bytes4 public reentryError;
    function setMode(uint8 value) external onlyOwner { mode = value; }
    function confiscate(address from, uint256 amount) external onlyOwner { _burn(from, amount); }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (mode == 2) return false;
        if (mode == 3) _reenter(msg.sender);
        return super.transfer(to, amount);
    }
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (mode == 2) return false;
        if (mode == 3) _reenter(msg.sender);
        return super.transferFrom(from, to, amount);
    }
    function _update(address from, address to, uint256 amount) internal override {
        if (mode == 1 && from != address(0) && to != address(0) && amount > 0) {
            super._update(from, address(0), 1);
            super._update(from, to, amount - 1);
        } else super._update(from, to, amount);
    }
    function _reenter(address target) private {
        (bool success, bytes memory data) = target.call(abi.encodeWithSignature("deposit(uint256)", 1));
        require(!success && data.length >= 4, "expected guarded callback");
        reentryError = bytes4(data);
    }
}

contract SixDecimalAsset is TestToken {
    function decimals() public pure override returns (uint8) { return 6; }
}
