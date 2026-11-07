// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Transferable receipts; binding is immutable and there is no admin mint path.
contract PoolShareToken is ERC20 {
    address public immutable pool;
    error InvalidPool();
    error OnlyPool();

    constructor(address pool_) ERC20("DeFi Shield Pool Share", "DSPS") {
        if (pool_ == address(0) || pool_.code.length == 0) revert InvalidPool();
        pool = pool_;
    }

    modifier onlyPool() {
        if (msg.sender != pool) revert OnlyPool();
        _;
    }

    function mint(address to, uint256 amount) external onlyPool { _mint(to, amount); }
    function burn(address from, uint256 amount) external onlyPool { _burn(from, amount); }
}
