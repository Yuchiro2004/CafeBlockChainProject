// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/// @title LoyaltyPoint
/// @notice Simple loyalty point token. The shop owner mints (gives) points to
///         customers, and customers redeem (burn) points they have earned.
///         No business logic (what a redeem "gets" the customer) lives on
///         chain here — that is intentionally left to whoever runs the shop.
contract LoyaltyPoint is ERC20, Ownable, Pausable {
    event PointsGiven(address indexed to, uint256 amount);
    event PointsRedeemed(address indexed customer, uint256 amount);

    constructor() ERC20("LoyaltyPoint", "LYT") Ownable(msg.sender) {}

    /// @notice Loyalty points are whole numbers — no fractional points.
    function decimals() public pure override returns (uint8) {
        return 0;
    }

    /// @notice Owner gives loyalty points to a customer.
    function mint(address to, uint256 amount) external onlyOwner whenNotPaused {
        require(to != address(0), "Cannot mint to zero address");
        require(amount > 0, "Amount must be > 0");
        _mint(to, amount);
        emit PointsGiven(to, amount);
    }

    /// @notice Customer redeems (burns) their own loyalty points.
    function redeem(uint256 amount) external whenNotPaused {
        require(amount > 0, "Amount must be > 0");
        require(balanceOf(msg.sender) >= amount, "Insufficient point balance");
        _burn(msg.sender, amount);
        emit PointsRedeemed(msg.sender, amount);
    }

    /// @notice Owner pauses the contract (blocks mint/redeem/transfer).
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Owner unpauses the contract.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Enforce pause on every balance-changing operation (mint/burn/transfer).
    function _update(address from, address to, uint256 value) internal override whenNotPaused {
        super._update(from, to, value);
    }
}
