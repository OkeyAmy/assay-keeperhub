// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {IntentRegistry} from "../src/IntentRegistry.sol";
import {ReceiptRegistry} from "../src/ReceiptRegistry.sol";

contract ReceiptRegistryTest is Test {
    IntentRegistry internal intents;
    ReceiptRegistry internal receipts;

    address internal verifier = address(0xA1);
    address internal otherVerifier = address(0xB2);

    uint8 internal constant VERIFIED = 1;
    uint8 internal constant DIVERGENT = 2;
    uint8 internal constant UNPROVEN = 3;
    uint8 internal constant NOT_EXECUTED = 4;

    bytes32 internal constant ZERO = bytes32(0);
    uint256 internal constant CHAIN_SEPOLIA = 11155111;

    function setUp() public {
        intents = new IntentRegistry();
        receipts = new ReceiptRegistry(intents);
        vm.warp(1_700_000_000);
    }

    function _commit(bytes32 intentHash) internal returns (bytes32) {
        vm.prank(verifier);
        intents.commit(intentHash, CHAIN_SEPOLIA, uint64(block.timestamp + 900));
        return intentHash;
    }

    function _write(bytes32 intentHash, bytes32 txHash, uint8 verdict, bytes32 prev)
        internal
        returns (bytes32)
    {
        vm.prank(verifier);
        return receipts.write(
            intentHash, txHash, verdict, keccak256("ALL_CHECKS_PASSED"), prev, uint64(block.timestamp)
        );
    }

    function test_write_storesReceipt() public {
        bytes32 intentHash = _commit(keccak256("i1"));
        bytes32 txHash = keccak256("tx1");

        bytes32 receiptHash = _write(intentHash, txHash, VERIFIED, ZERO);

        ReceiptRegistry.Receipt memory r = receipts.get(receiptHash);
        assertEq(r.intentHash, intentHash);
        assertEq(r.txHash, txHash);
        assertEq(r.verdict, VERIFIED);
        assertEq(r.verifier, verifier);
        assertEq(r.prevHash, ZERO);
    }

    function test_write_advancesHead() public {
        bytes32 i1 = _commit(keccak256("i1"));
        assertEq(receipts.head(verifier), ZERO);

        bytes32 r1 = _write(i1, keccak256("tx1"), VERIFIED, ZERO);
        assertEq(receipts.head(verifier), r1);

        bytes32 i2 = _commit(keccak256("i2"));
        bytes32 r2 = _write(i2, keccak256("tx2"), DIVERGENT, r1);
        assertEq(receipts.head(verifier), r2);
    }

    /// @dev The tamper-evidence property: a caller cannot append while claiming
    ///      a previous head other than the real one, so it cannot quietly fork.
    function test_write_revertsOnBrokenChain() public {
        bytes32 i1 = _commit(keccak256("i1"));
        bytes32 r1 = _write(i1, keccak256("tx1"), VERIFIED, ZERO);

        bytes32 i2 = _commit(keccak256("i2"));
        vm.prank(verifier);
        vm.expectRevert(
            abi.encodeWithSelector(ReceiptRegistry.ChainBroken.selector, r1, keccak256("wrong"))
        );
        receipts.write(
            i2, keccak256("tx2"), VERIFIED, keccak256("R"), keccak256("wrong"), uint64(block.timestamp)
        );
    }

    /// @dev Dropping a receipt must be detectable: after r1, only r1 is a valid
    ///      predecessor, so a chain that omits it cannot be extended.
    function test_write_cannotSkipALink() public {
        bytes32 i1 = _commit(keccak256("i1"));
        _write(i1, keccak256("tx1"), DIVERGENT, ZERO);

        bytes32 i2 = _commit(keccak256("i2"));
        vm.prank(verifier);
        // Pretending the divergent receipt never happened means claiming ZERO.
        vm.expectRevert();
        receipts.write(i2, keccak256("tx2"), VERIFIED, keccak256("R"), ZERO, uint64(block.timestamp));
    }

    function test_write_chainsArePerVerifier() public {
        bytes32 i1 = _commit(keccak256("i1"));
        bytes32 r1 = _write(i1, keccak256("tx1"), VERIFIED, ZERO);

        // A second verifier starts from its own genesis, unaffected by the first.
        vm.prank(otherVerifier);
        bytes32 r2 = receipts.write(
            i1, keccak256("tx1"), DIVERGENT, keccak256("R"), ZERO, uint64(block.timestamp)
        );

        assertEq(receipts.head(verifier), r1);
        assertEq(receipts.head(otherVerifier), r2);
        assertTrue(r1 != r2);
    }

    function test_write_revertsOnUnknownVerdict() public {
        bytes32 i1 = _commit(keccak256("i1"));

        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(ReceiptRegistry.UnknownVerdict.selector, uint8(0)));
        receipts.write(i1, ZERO, 0, keccak256("R"), ZERO, uint64(block.timestamp));

        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(ReceiptRegistry.UnknownVerdict.selector, uint8(5)));
        receipts.write(i1, ZERO, 5, keccak256("R"), ZERO, uint64(block.timestamp));
    }

    /// @dev A verdict about an uncommitted intent is unfalsifiable — there is no
    ///      prior commitment to compare an execution against.
    function test_write_revertsWhenIntentNeverCommitted() public {
        bytes32 ghost = keccak256("never-committed");
        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(ReceiptRegistry.IntentNotCommitted.selector, ghost));
        receipts.write(ghost, ZERO, VERIFIED, keccak256("R"), ZERO, uint64(block.timestamp));
    }

    /// @dev KeeperHub #1784: an execution with no reported txHash still deserves
    ///      a receipt. It is recorded as UNPROVEN with a zero hash, not skipped.
    function test_write_acceptsZeroTxHashAsUnproven() public {
        bytes32 i1 = _commit(keccak256("i1"));
        bytes32 r = _write(i1, ZERO, UNPROVEN, ZERO);

        ReceiptRegistry.Receipt memory rec = receipts.get(r);
        assertEq(rec.txHash, ZERO);
        assertEq(rec.verdict, UNPROVEN);
    }

    function test_get_revertsForUnknownReceipt() public {
        bytes32 ghost = keccak256("nope");
        vm.expectRevert(abi.encodeWithSelector(ReceiptRegistry.UnknownReceipt.selector, ghost));
        receipts.get(ghost);
    }

    function test_receiptsForIntent_collectsRepeatVerifications() public {
        bytes32 i1 = _commit(keccak256("i1"));
        bytes32 r1 = _write(i1, keccak256("tx1"), UNPROVEN, ZERO);
        // Same intent, re-verified later with better data.
        bytes32 r2 = _write(i1, keccak256("tx1"), VERIFIED, r1);

        bytes32[] memory found = receipts.receiptsForIntent(i1);
        assertEq(found.length, 2);
        assertEq(found[0], r1);
        assertEq(found[1], r2);
    }

    function test_summary_countsByVerdict() public {
        bytes32 prev = ZERO;
        uint8[4] memory verdicts = [VERIFIED, VERIFIED, DIVERGENT, UNPROVEN];

        for (uint256 i; i < verdicts.length; i++) {
            bytes32 intentHash = _commit(keccak256(abi.encode("i", i)));
            prev = _write(intentHash, keccak256(abi.encode("tx", i)), verdicts[i], prev);
        }

        (uint256 verified, uint256 divergent, uint256 unproven, uint256 notExecuted) =
            receipts.summary(verifier);
        assertEq(verified, 2);
        assertEq(divergent, 1);
        assertEq(unproven, 1);
        assertEq(notExecuted, 0);
    }

    function test_chainFrom_walksBackwards() public {
        bytes32 prev = ZERO;
        bytes32[] memory written = new bytes32[](3);

        for (uint256 i; i < 3; i++) {
            bytes32 intentHash = _commit(keccak256(abi.encode("i", i)));
            prev = _write(intentHash, keccak256(abi.encode("tx", i)), VERIFIED, prev);
            written[i] = prev;
        }

        ReceiptRegistry.Receipt[] memory walk = receipts.chainFrom(receipts.head(verifier), 10);
        assertEq(walk.length, 3);
        // Newest first when walking back from the head.
        assertEq(walk[0].intentHash, receipts.get(written[2]).intentHash);
        assertEq(walk[2].intentHash, receipts.get(written[0]).intentHash);
    }

    function test_chainFrom_stopsAtLimit() public {
        bytes32 prev = ZERO;
        for (uint256 i; i < 5; i++) {
            bytes32 intentHash = _commit(keccak256(abi.encode("i", i)));
            prev = _write(intentHash, keccak256(abi.encode("tx", i)), VERIFIED, prev);
        }

        ReceiptRegistry.Receipt[] memory walk = receipts.chainFrom(receipts.head(verifier), 2);
        assertEq(walk.length, 2);
    }

    function test_chainFrom_emptyForUnknownStart() public view {
        ReceiptRegistry.Receipt[] memory walk = receipts.chainFrom(keccak256("ghost"), 5);
        assertEq(walk.length, 0);
    }

    function test_receiptsAt_paginates() public {
        bytes32 prev = ZERO;
        for (uint256 i; i < 5; i++) {
            bytes32 intentHash = _commit(keccak256(abi.encode("i", i)));
            prev = _write(intentHash, keccak256(abi.encode("tx", i)), VERIFIED, prev);
        }

        assertEq(receipts.totalReceipts(), 5);
        assertEq(receipts.receiptsAt(0, 2).length, 2);
        assertEq(receipts.receiptsAt(3, 10).length, 2);
        assertEq(receipts.receiptsAt(10, 5).length, 0);
    }

    /// @dev The offchain chain builder in @assay/core must agree byte-for-byte,
    ///      or a chain assembled in TypeScript will not validate here.
    function test_hashReceipt_matchesAbiEncode() public view {
        bytes32 intentHash = keccak256("i");
        bytes32 txHash = keccak256("t");
        bytes32 reasonHash = keccak256("ALL_CHECKS_PASSED");
        uint64 observedAt = 1_700_000_000;

        bytes32 expected =
            keccak256(abi.encode(intentHash, txHash, VERIFIED, reasonHash, ZERO, observedAt));

        assertEq(
            receipts.hashReceipt(intentHash, txHash, VERIFIED, reasonHash, ZERO, observedAt), expected
        );
    }

    // --- fuzz ---------------------------------------------------------------

    function testFuzz_write_roundTrips(bytes32 seed, uint8 verdict, uint64 observedAt) public {
        vm.assume(seed != bytes32(0));
        verdict = uint8(bound(verdict, 1, 4));

        bytes32 intentHash = _commit(seed);
        bytes32 reasonHash = keccak256(abi.encode(seed, verdict));

        vm.prank(verifier);
        bytes32 receiptHash =
            receipts.write(intentHash, seed, verdict, reasonHash, ZERO, observedAt);

        ReceiptRegistry.Receipt memory r = receipts.get(receiptHash);
        assertEq(r.verdict, verdict);
        assertEq(r.observedAt, observedAt);
        assertEq(r.reasonHash, reasonHash);
        assertEq(receipts.head(verifier), receiptHash);
    }

    /// @dev The core invariant: the chain is always walkable back to genesis,
    ///      and its length always equals the number of receipts written.
    function testFuzz_chainIsAlwaysIntact(uint8 count) public {
        count = uint8(bound(count, 1, 20));

        bytes32 prev = ZERO;
        for (uint256 i; i < count; i++) {
            bytes32 intentHash = _commit(keccak256(abi.encode("fuzz", i)));
            prev = _write(intentHash, keccak256(abi.encode("tx", i)), VERIFIED, prev);
        }

        ReceiptRegistry.Receipt[] memory walk = receipts.chainFrom(receipts.head(verifier), count);
        assertEq(walk.length, count);

        // Each link must point at the hash of its predecessor.
        for (uint256 i; i < walk.length - 1; i++) {
            bytes32 predecessorHash = receipts.hashReceipt(
                walk[i + 1].intentHash,
                walk[i + 1].txHash,
                walk[i + 1].verdict,
                walk[i + 1].reasonHash,
                walk[i + 1].prevHash,
                walk[i + 1].observedAt
            );
            assertEq(walk[i].prevHash, predecessorHash);
        }
    }

    function testFuzz_write_rejectsOutOfRangeVerdict(uint8 verdict) public {
        vm.assume(verdict == 0 || verdict > 4);
        bytes32 intentHash = _commit(keccak256("i"));

        vm.prank(verifier);
        vm.expectRevert(abi.encodeWithSelector(ReceiptRegistry.UnknownVerdict.selector, verdict));
        receipts.write(intentHash, ZERO, verdict, keccak256("R"), ZERO, uint64(block.timestamp));
    }
}
