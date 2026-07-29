// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.35;

import {IntentRegistry} from "./IntentRegistry.sol";

/// @title ReceiptRegistry
/// @notice Hash-chained verdicts on whether executions did what was committed.
/// @dev Chained rather than standalone for one reason: a verifier that only
///      publishes its convenient results is not a verifier. Each receipt links
///      to the hash of the previous one, so dropping or reordering any receipt
///      breaks every link after it, and the head is public. Selective
///      publication becomes visible rather than merely dishonest.
///
///      The record shape follows ERC-8004's validation vocabulary (a request
///      identified by a hash, answered by a scored response from a named
///      validator) so receipts slot into the identity and reputation registries
///      KeeperHub's marketplace already registers workflows against.
contract ReceiptRegistry {
    /// @dev Kept numerically in sync with `VERDICT_CODE` in @assay/core.
    uint8 internal constant VERDICT_VERIFIED = 1;
    uint8 internal constant VERDICT_DIVERGENT = 2;
    uint8 internal constant VERDICT_UNPROVEN = 3;
    uint8 internal constant VERDICT_NOT_EXECUTED = 4;

    struct Receipt {
        bytes32 intentHash;
        /// @dev Zero when the executor never reported one — see KeeperHub #1784.
        bytes32 txHash;
        uint8 verdict;
        bytes32 reasonHash;
        bytes32 prevHash;
        uint64 observedAt;
        address verifier;
        uint64 blockNumber;
    }

    IntentRegistry public immutable INTENTS;

    /// @dev Head of each verifier's chain. Zero until its first receipt.
    mapping(address verifier => bytes32) public head;

    /// @dev Number of receipts each verifier has written, by verdict.
    mapping(address verifier => mapping(uint8 verdict => uint256)) public verdictCount;

    mapping(bytes32 receiptHash => Receipt) private _receipts;

    /// @dev Receipts for a given intent. An intent can be re-verified later —
    ///      by a different verifier, or by the same one with better data — so
    ///      this is a list rather than a single slot.
    mapping(bytes32 intentHash => bytes32[]) private _byIntent;

    /// @dev Append-only log of every receipt hash, for offchain enumeration.
    bytes32[] private _all;

    event ReceiptWritten(
        bytes32 indexed receiptHash,
        bytes32 indexed intentHash,
        address indexed verifier,
        uint8 verdict,
        bytes32 txHash,
        bytes32 prevHash
    );

    error UnknownVerdict(uint8 verdict);
    error ChainBroken(bytes32 expectedPrev, bytes32 providedPrev);
    error DuplicateReceipt(bytes32 receiptHash);
    error IntentNotCommitted(bytes32 intentHash);
    error UnknownReceipt(bytes32 receiptHash);

    constructor(IntentRegistry intents) {
        INTENTS = intents;
    }

    /// @notice Append a verdict to the caller's receipt chain.
    /// @dev `prevHash` is supplied by the caller and checked against the stored
    ///      head rather than being read implicitly. That makes a caller working
    ///      from a stale view fail loudly instead of silently forking its own
    ///      chain, which would defeat the tamper-evidence the chain provides.
    /// @param intentHash Intent this verdict is about. Must already be committed.
    /// @param txHash Transaction that was verified, or zero if none existed.
    /// @param verdict One of the VERDICT_* codes.
    /// @param reasonHash keccak256 of the machine-readable reason string.
    /// @param prevHash Caller's current chain head.
    /// @param observedAt Unix seconds at which the verdict was reached.
    function write(
        bytes32 intentHash,
        bytes32 txHash,
        uint8 verdict,
        bytes32 reasonHash,
        bytes32 prevHash,
        uint64 observedAt
    ) external returns (bytes32 receiptHash) {
        if (verdict == 0 || verdict > VERDICT_NOT_EXECUTED) revert UnknownVerdict(verdict);

        // A verdict about an intent nobody committed to is unfalsifiable: there
        // is no prior commitment to compare the execution against.
        if (!INTENTS.isCommitted(intentHash)) revert IntentNotCommitted(intentHash);

        bytes32 expectedPrev = head[msg.sender];
        if (prevHash != expectedPrev) revert ChainBroken(expectedPrev, prevHash);

        receiptHash = _hashReceipt(intentHash, txHash, verdict, reasonHash, prevHash, observedAt);
        if (_receipts[receiptHash].verifier != address(0)) revert DuplicateReceipt(receiptHash);

        _receipts[receiptHash] = Receipt({
            intentHash: intentHash,
            txHash: txHash,
            verdict: verdict,
            reasonHash: reasonHash,
            prevHash: prevHash,
            observedAt: observedAt,
            verifier: msg.sender,
            blockNumber: uint64(block.number)
        });

        head[msg.sender] = receiptHash;
        verdictCount[msg.sender][verdict] += 1;
        _byIntent[intentHash].push(receiptHash);
        _all.push(receiptHash);

        emit ReceiptWritten(receiptHash, intentHash, msg.sender, verdict, txHash, prevHash);
    }

    /// @notice Hash of a receipt's contents.
    /// @dev Must stay byte-identical to `hashReceipt` in @assay/core, or a chain
    ///      built offchain will not validate onchain. Cross-checked by
    ///      `test/ReceiptRegistry.t.sol` against a vector from the TypeScript side.
    function hashReceipt(
        bytes32 intentHash,
        bytes32 txHash,
        uint8 verdict,
        bytes32 reasonHash,
        bytes32 prevHash,
        uint64 observedAt
    ) external pure returns (bytes32) {
        return _hashReceipt(intentHash, txHash, verdict, reasonHash, prevHash, observedAt);
    }

    function _hashReceipt(
        bytes32 intentHash,
        bytes32 txHash,
        uint8 verdict,
        bytes32 reasonHash,
        bytes32 prevHash,
        uint64 observedAt
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(intentHash, txHash, verdict, reasonHash, prevHash, observedAt));
    }

    function get(bytes32 receiptHash) external view returns (Receipt memory) {
        Receipt memory r = _receipts[receiptHash];
        if (r.verifier == address(0)) revert UnknownReceipt(receiptHash);
        return r;
    }

    function exists(bytes32 receiptHash) external view returns (bool) {
        return _receipts[receiptHash].verifier != address(0);
    }

    function receiptsForIntent(bytes32 intentHash) external view returns (bytes32[] memory) {
        return _byIntent[intentHash];
    }

    function totalReceipts() external view returns (uint256) {
        return _all.length;
    }

    /// @notice Page through every receipt, newest last.
    function receiptsAt(uint256 offset, uint256 limit) external view returns (bytes32[] memory page) {
        uint256 total = _all.length;
        if (offset >= total) return new bytes32[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        page = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = _all[i];
        }
    }

    /// @notice Walk a verifier's chain backwards from its head.
    /// @dev Lets anyone reconstruct and check the chain without an indexer,
    ///      which matters because the tamper-evidence is worthless if verifying
    ///      it requires trusting a server.
    function chainFrom(bytes32 startHash, uint256 limit) external view returns (Receipt[] memory out) {
        Receipt[] memory buffer = new Receipt[](limit);
        uint256 count;
        bytes32 cursor = startHash;

        while (count < limit && cursor != bytes32(0)) {
            Receipt memory r = _receipts[cursor];
            if (r.verifier == address(0)) break;
            buffer[count++] = r;
            cursor = r.prevHash;
        }

        out = new Receipt[](count);
        for (uint256 i; i < count; i++) {
            out[i] = buffer[i];
        }
    }

    /// @notice Verified / divergent / unproven / not-executed tallies for a verifier.
    /// @dev A verifier that never reports anything but VERIFIED is itself a
    ///      finding, so the mix is made cheap to read.
    function summary(address verifier)
        external
        view
        returns (uint256 verified, uint256 divergent, uint256 unproven, uint256 notExecuted)
    {
        verified = verdictCount[verifier][VERDICT_VERIFIED];
        divergent = verdictCount[verifier][VERDICT_DIVERGENT];
        unproven = verdictCount[verifier][VERDICT_UNPROVEN];
        notExecuted = verdictCount[verifier][VERDICT_NOT_EXECUTED];
    }
}
