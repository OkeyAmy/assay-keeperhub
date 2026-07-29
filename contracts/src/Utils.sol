// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.35;

library Utils {
    /// @notice Compare two byte arrays without an explicit loop.
    function bytesEqual(
        bytes memory a,
        bytes memory b
    ) internal pure returns (bool) {
        return keccak256(a) == keccak256(b);
    }

    /// @notice Derive an Ethereum address from an uncompressed 64-byte secp256k1 public key.
    /// @dev The public key is the uncompressed form WITHOUT the 0x04 prefix (X || Y, 64 bytes).
    function pubKeyToAddress(
        bytes memory pubKey
    ) internal pure returns (address) {
        require(pubKey.length == 64, "Invalid public key length");
        bytes32 hash = keccak256(pubKey);
        return address(uint160(uint256(hash)));
    }
}
