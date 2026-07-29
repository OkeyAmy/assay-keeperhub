// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.35;

/// @title IntentRegistry
/// @notice Records what an agent committed to doing, before it does it.
/// @dev The point of committing first is that it converts an after-the-fact
///      claim into a guarantee. Anyone can attest "I meant to do that" once the
///      transaction is mined; only a commitment written beforehand, with a
///      block timestamp to prove it, rules out writing the story afterwards.
///
///      This contract stores hashes, never plaintext. The intent itself lives
///      offchain; what is onchain is the fact that the agent was bound to it at
///      a specific block. Keeps commitments cheap and keeps strategy private.
contract IntentRegistry {
    /// @param committer The address that bound itself to this intent.
    /// @param blockNumber Block the commitment landed in.
    /// @param timestamp Block timestamp of the commitment.
    /// @param deadline Unix seconds after which the intent is void.
    /// @param chainId Chain the intended action targets.
    struct Commitment {
        address committer;
        uint64 blockNumber;
        uint64 timestamp;
        uint64 deadline;
        uint256 chainId;
    }

    mapping(bytes32 intentHash => Commitment) private _commitments;

    /// @dev Per-committer counter, so an agent can prove it did not skip intents.
    mapping(address committer => uint256) public commitCount;

    event IntentCommitted(
        bytes32 indexed intentHash,
        address indexed committer,
        uint256 indexed chainId,
        uint64 deadline,
        uint256 sequence
    );

    error AlreadyCommitted(bytes32 intentHash);
    error NotCommitted(bytes32 intentHash);
    error DeadlineInPast(uint64 deadline, uint256 nowTs);
    error EmptyIntentHash();

    /// @notice Bind the caller to an intent hash.
    /// @dev Reverts on a repeat commitment. Re-committing the same hash would
    ///      let a caller move its own timestamp forward, which is exactly the
    ///      rewrite the contract exists to prevent. A genuinely new attempt has
    ///      a different nonce, so a different hash.
    /// @param intentHash Canonical hash of the intent, per @assay/core `hashIntent`.
    /// @param chainId Chain the intended action targets.
    /// @param deadline Unix seconds after which the intent is void.
    function commit(bytes32 intentHash, uint256 chainId, uint64 deadline) external {
        if (intentHash == bytes32(0)) revert EmptyIntentHash();
        if (_commitments[intentHash].committer != address(0)) {
            revert AlreadyCommitted(intentHash);
        }
        if (deadline <= block.timestamp) {
            revert DeadlineInPast(deadline, block.timestamp);
        }

        uint256 sequence = ++commitCount[msg.sender];

        _commitments[intentHash] = Commitment({
            committer: msg.sender,
            blockNumber: uint64(block.number),
            timestamp: uint64(block.timestamp),
            deadline: deadline,
            chainId: chainId
        });

        emit IntentCommitted(intentHash, msg.sender, chainId, deadline, sequence);
    }

    /// @notice Read a commitment. Reverts if the hash was never committed.
    function get(bytes32 intentHash) external view returns (Commitment memory) {
        Commitment memory c = _commitments[intentHash];
        if (c.committer == address(0)) revert NotCommitted(intentHash);
        return c;
    }

    /// @notice Whether this hash has been committed at all.
    function isCommitted(bytes32 intentHash) external view returns (bool) {
        return _commitments[intentHash].committer != address(0);
    }

    /// @notice Whether the commitment exists and has not expired.
    /// @dev Separate from `isCommitted` because "never committed" and "committed
    ///      but stale" produce different verdicts offchain (NOT_EXECUTED with
    ///      NO_EXECUTION_ATTEMPTED versus INTENT_EXPIRED).
    function isLive(bytes32 intentHash) external view returns (bool) {
        Commitment memory c = _commitments[intentHash];
        return c.committer != address(0) && c.deadline > block.timestamp;
    }

    /// @notice Block number a commitment landed in, or 0 if never committed.
    /// @dev Used offchain to assert the commitment preceded the execution.
    function committedAtBlock(bytes32 intentHash) external view returns (uint64) {
        return _commitments[intentHash].blockNumber;
    }
}
