// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract LoyaltyPoints is ERC20, Ownable, Pausable {

    error ZeroAddress();
    
    error ZeroAmount();

    event PointsMinted(address indexed to, uint256 amount);

    event PointsRedeemed(address indexed from, uint256 amount);

    constructor() ERC20("Loyalty Point", "LOYAL") Ownable(msg.sender) {}

    function mintPoints(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        _mint(to, amount);
        emit PointsMinted(to, amount);
    }

    function redeemPoints(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        
        _burn(msg.sender, amount);
        emit PointsRedeemed(msg.sender, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override whenNotPaused {
        super._update(from, to, value);
    }
}