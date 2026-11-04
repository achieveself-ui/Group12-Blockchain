// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/* ==========================================================================
 * MockERC20 —— 测试基建自带的模拟资产代币
 * --------------------------------------------------------------------------
 * 为什么要它：测试骨架要在 B 交付 src/TestToken.sol 之前就能编译、能演示，
 * 所以资产代币先用自包含的最小 ERC-20 顶上。
 * 与组长文件的衔接：TestToken.sol（B 的交付物）的固定接口就是
 *   mint(address to, uint256 amount) —— 仅所有者可铸造，
 * 与本 Mock 完全一致；B 交付后在 setUp 里把
 *   asset = new MockERC20("Test Token", "TTK");
 * 换成
 *   asset = new TestToken();   // 构造参数以 B 定稿为准
 * 其余测试代码零改动（测试全部通过 IERC20 / mint 接口访问，不碰实现细节）。
 *
 * 刻意不依赖 OpenZeppelin：让基建在 forge install 之外零依赖可编译。
 * ========================================================================== */
contract MockERC20 {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    string public name;
    string public symbol;
    uint8 public constant decimals = 18; // 组长文件 4.3：合约内一律用最小单位

    uint256 public totalSupply;
    address public owner; // 模拟 TestToken 的"仅所有者可 mint"权限

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    modifier onlyOwner() {
        require(msg.sender == owner, "MockERC20: caller is not owner");
        _;
    }

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
        owner = msg.sender;
    }

    /// @notice 仅所有者可铸造（与组长文件 TestToken 规则一致），供 setUp 派发测试资产
    function mint(address to, uint256 amount) external onlyOwner {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "MockERC20: insufficient allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        uint256 bal = balanceOf[from];
        require(bal >= amount, "MockERC20: insufficient balance"); // 0.8 下本会自动 revert，显式写让错误信息可读
        unchecked {
            balanceOf[from] = bal - amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
