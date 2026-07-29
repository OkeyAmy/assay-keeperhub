// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {IntentRegistry} from "../src/IntentRegistry.sol";

contract IntentRegistryTest is Test {
    IntentRegistry internal registry;

    address internal agent = address(0xA1);
    address internal other = address(0xB2);

    bytes32 internal constant HASH_A = keccak256("intent-a");
    bytes32 internal constant HASH_B = keccak256("intent-b");

    uint256 internal constant CHAIN_SEPOLIA = 11155111;

    function setUp() public {
        registry = new IntentRegistry();
        // Start at a non-zero timestamp so `deadline > block.timestamp` is a
        // meaningful constraint rather than trivially satisfied.
        vm.warp(1_700_000_000);
    }

    function _futureDeadline() internal view returns (uint64) {
        return uint64(block.timestamp + 900);
    }

    function test_commit_storesCommitment() public {
        vm.prank(agent);
        registry.commit(HASH_A, CHAIN_SEPOLIA, _futureDeadline());

        IntentRegistry.Commitment memory c = registry.get(HASH_A);
        assertEq(c.committer, agent);
        assertEq(c.chainId, CHAIN_SEPOLIA);
        assertEq(c.timestamp, uint64(block.timestamp));
        assertEq(c.blockNumber, uint64(block.number));
    }

    function test_commit_emitsEvent() public {
        uint64 deadline = _futureDeadline();

        vm.expectEmit(true, true, true, true);
        emit IntentRegistry.IntentCommitted(HASH_A, agent, CHAIN_SEPOLIA, deadline, 1);

        vm.prank(agent);
        registry.commit(HASH_A, CHAIN_SEPOLIA, deadline);
    }

    function test_commit_incrementsPerCommitterSequence() public {
        vm.startPrank(agent);
        registry.commit(HASH_A, CHAIN_SEPOLIA, _futureDeadline());
        registry.commit(HASH_B, CHAIN_SEPOLIA, _futureDeadline());
        vm.stopPrank();

        assertEq(registry.commitCount(agent), 2);
        assertEq(registry.commitCount(other), 0);
    }

    /// @dev Re-committing would let a caller move its own timestamp forward,
    ///      which is precisely the rewrite this contract exists to prevent.
    function test_commit_revertsOnDuplicate() public {
        vm.startPrank(agent);
        registry.commit(HASH_A, CHAIN_SEPOLIA, _futureDeadline());

        vm.expectRevert(abi.encodeWithSelector(IntentRegistry.AlreadyCommitted.selector, HASH_A));
        registry.commit(HASH_A, CHAIN_SEPOLIA, _futureDeadline());
        vm.stopPrank();
    }

    /// @dev Duplicate detection is global, not per-caller: a second committer
    ///      must not be able to overwrite the first one's timestamp.
    function test_commit_revertsOnDuplicateFromDifferentCommitter() public {
        vm.prank(agent);
        registry.commit(HASH_A, CHAIN_SEPOLIA, _futureDeadline());

        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(IntentRegistry.AlreadyCommitted.selector, HASH_A));
        registry.commit(HASH_A, CHAIN_SEPOLIA, _futureDeadline());
    }

    function test_commit_revertsOnZeroHash() public {
        vm.prank(agent);
        vm.expectRevert(IntentRegistry.EmptyIntentHash.selector);
        registry.commit(bytes32(0), CHAIN_SEPOLIA, _futureDeadline());
    }

    function test_commit_revertsOnPastDeadline() public {
        uint64 past = uint64(block.timestamp);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(IntentRegistry.DeadlineInPast.selector, past, block.timestamp)
        );
        registry.commit(HASH_A, CHAIN_SEPOLIA, past);
    }

    function test_get_revertsWhenNeverCommitted() public {
        vm.expectRevert(abi.encodeWithSelector(IntentRegistry.NotCommitted.selector, HASH_A));
        registry.get(HASH_A);
    }

    function test_isCommitted() public {
        assertFalse(registry.isCommitted(HASH_A));
        vm.prank(agent);
        registry.commit(HASH_A, CHAIN_SEPOLIA, _futureDeadline());
        assertTrue(registry.isCommitted(HASH_A));
    }

    /// @dev "never committed" and "committed but stale" must stay
    ///      distinguishable — they map to different offchain verdicts.
    function test_isLive_falseAfterDeadline() public {
        uint64 deadline = _futureDeadline();
        vm.prank(agent);
        registry.commit(HASH_A, CHAIN_SEPOLIA, deadline);

        assertTrue(registry.isLive(HASH_A));

        vm.warp(uint256(deadline) + 1);
        assertFalse(registry.isLive(HASH_A));
        // Still committed — it expired, it did not vanish.
        assertTrue(registry.isCommitted(HASH_A));
    }

    function test_isLive_falseWhenNeverCommitted() public view {
        assertFalse(registry.isLive(HASH_A));
    }

    function test_committedAtBlock_zeroWhenAbsent() public view {
        assertEq(registry.committedAtBlock(HASH_A), 0);
    }

    function test_committedAtBlock_recordsBlock() public {
        vm.roll(500);
        vm.prank(agent);
        registry.commit(HASH_A, CHAIN_SEPOLIA, _futureDeadline());
        assertEq(registry.committedAtBlock(HASH_A), 500);
    }

    // --- fuzz ---------------------------------------------------------------

    function testFuzz_commit_roundTrips(bytes32 intentHash, uint256 chainId, uint32 ttl) public {
        vm.assume(intentHash != bytes32(0));
        ttl = uint32(bound(ttl, 1, type(uint32).max));
        uint64 deadline = uint64(block.timestamp + ttl);

        vm.prank(agent);
        registry.commit(intentHash, chainId, deadline);

        IntentRegistry.Commitment memory c = registry.get(intentHash);
        assertEq(c.committer, agent);
        assertEq(c.chainId, chainId);
        assertEq(c.deadline, deadline);
        assertTrue(registry.isCommitted(intentHash));
    }

    function testFuzz_commit_isAlwaysOnceOnly(bytes32 intentHash) public {
        vm.assume(intentHash != bytes32(0));
        uint64 deadline = _futureDeadline();

        vm.startPrank(agent);
        registry.commit(intentHash, CHAIN_SEPOLIA, deadline);
        vm.expectRevert(abi.encodeWithSelector(IntentRegistry.AlreadyCommitted.selector, intentHash));
        registry.commit(intentHash, CHAIN_SEPOLIA, deadline);
        vm.stopPrank();
    }

    /// @dev Commitment timestamp must never be later than the observing block,
    ///      or "committed before execution" stops meaning anything.
    function testFuzz_commitmentNeverPostdatesItsBlock(bytes32 intentHash, uint32 ttl) public {
        vm.assume(intentHash != bytes32(0));
        ttl = uint32(bound(ttl, 1, type(uint32).max));

        vm.prank(agent);
        registry.commit(intentHash, CHAIN_SEPOLIA, uint64(block.timestamp + ttl));

        IntentRegistry.Commitment memory c = registry.get(intentHash);
        assertLe(c.timestamp, uint64(block.timestamp));
        assertLe(c.blockNumber, uint64(block.number));
    }
}
