// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Launchpad} from "../src/Launchpad.sol";

/**
 * Deploys the Launchpad.
 *
 *   # local chain (anvil)
 *   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key $KEY
 *
 *   # HyperEVM testnet (chain 998), then verify the address in your explorer before using it
 *   forge script script/Deploy.s.sol --rpc-url https://rpc.hyperliquid-testnet.xyz/evm --broadcast --private-key $KEY
 *
 * Environment (all optional):
 *   OWNER       address that may withdraw protocol fees (default: the deployer). Use a multisig for anything real.
 *   LAUNCH_FEE  wei charged per launch (default 0: launching is free; coins still earn trading fees)
 *
 * Any chain other than a local anvil (31337) or the HyperEVM testnet (998) is a real-money network and is refused
 * unless ALLOW_MAINNET=1 is set: the contracts are unaudited. That covers HyperEVM (999) and Elysium (99901).
 */
contract Deploy is Script {
    function run() external returns (Launchpad pad) {
        bool testNetwork = block.chainid == 31337 || block.chainid == 998;
        if (!testNetwork && vm.envOr("ALLOW_MAINNET", uint256(0)) != 1) {
            revert("Refusing to deploy unaudited contracts to a real-money network. Set ALLOW_MAINNET=1 only after an audit.");
        }
        address owner = vm.envOr("OWNER", msg.sender);
        uint256 launchFee = vm.envOr("LAUNCH_FEE", uint256(0));

        uint256[] memory tiers = new uint256[](3);
        tiers[0] = 400 ether;
        tiers[1] = 800 ether;
        tiers[2] = 1600 ether;

        vm.startBroadcast();
        pad = new Launchpad(owner, launchFee, tiers);
        vm.stopBroadcast();

        console.log("Launchpad deployed at:", address(pad));
        console.log("chainId:", block.chainid);
        console.log("owner:", owner);
        console.log("deploy block:", block.number);
    }
}
