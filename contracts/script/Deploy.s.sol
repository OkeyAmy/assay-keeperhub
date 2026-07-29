// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.35;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IntentRegistry} from "../src/IntentRegistry.sol";
import {ReceiptRegistry} from "../src/ReceiptRegistry.sol";

/// @notice One-time deployment of the two registries.
/// @dev This is the only place in the project that signs with a raw private key.
///      It is deliberately not part of the agent: deployment is setup, whereas
///      every agent-initiated transaction goes through KeeperHub. Keeping the
///      key here and nowhere else is what makes that claim checkable.
///
///      Run with:
///        DEPLOYER_PRIVATE_KEY=0x... DEPLOY_RPC_URL=https://... pnpm deploy
contract Deploy is Script {
    function run() external returns (IntentRegistry intents, ReceiptRegistry receipts) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);

        intents = new IntentRegistry();
        receipts = new ReceiptRegistry(intents);

        vm.stopBroadcast();

        console2.log("chain id          ", block.chainid);
        console2.log("IntentRegistry    ", address(intents));
        console2.log("ReceiptRegistry   ", address(receipts));
        console2.log("");
        console2.log("Add these to .env:");
        console2.log("INTENT_REGISTRY=%s", address(intents));
        console2.log("RECEIPT_REGISTRY=%s", address(receipts));
    }
}
