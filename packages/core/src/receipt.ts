import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex, type Hex } from 'viem';
import { VERDICT_CODE, type Verdict } from './verdict.js';

/** The zero hash, used as the previous link of the first receipt in a chain. */
export const GENESIS_LINK = `0x${'00'.repeat(32)}` as Hex;

/**
 * A single link in the receipt chain.
 *
 * Chained rather than standalone so that receipts cannot be silently dropped or
 * backdated: removing one breaks every link after it, and the head is public.
 * An executor that only publishes its convenient results has a visibly broken
 * chain, which is a stronger guarantee than any individual signature.
 */
export interface Receipt {
  intentHash: Hex;
  /** Zero hash when the execution produced no transaction (see issue #1784). */
  txHash: Hex;
  /** Numeric verdict, matching ReceiptRegistry.sol. */
  verdict: number;
  /** Machine-readable reason code, hashed for compact onchain storage. */
  reasonHash: Hex;
  /** keccak of the previous receipt's own hash. GENESIS_LINK for the first. */
  prevHash: Hex;
  /** Unix seconds. */
  observedAt: bigint;
}

export const ZERO_HASH = GENESIS_LINK;

/** Build the onchain receipt for a verdict, linked to the previous one. */
export function buildReceipt(verdict: Verdict, prevHash: Hex = GENESIS_LINK): Receipt {
  return {
    intentHash: verdict.intentHash,
    txHash: verdict.txHash ?? ZERO_HASH,
    verdict: VERDICT_CODE[verdict.kind],
    reasonHash: hashReason(verdict.reason),
    prevHash,
    observedAt: BigInt(Math.floor(verdict.observedAt / 1000)),
  };
}

export function hashReason(reason: string): Hex {
  return keccak256(stringToHex(reason));
}

/**
 * The receipt's own hash — what the next receipt links back to.
 *
 * Must stay byte-identical to `ReceiptRegistry._hashReceipt`, or the chain
 * built offchain will not match the chain verified onchain. There is a
 * cross-checking test in `packages/core/test/receipt.test.ts` and a Solidity
 * counterpart in `contracts/test/ReceiptRegistry.t.sol`.
 */
export function hashReceipt(receipt: Receipt): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters('bytes32, bytes32, uint8, bytes32, bytes32, uint64'),
      [
        receipt.intentHash,
        receipt.txHash,
        receipt.verdict,
        receipt.reasonHash,
        receipt.prevHash,
        receipt.observedAt,
      ],
    ),
  );
}

/**
 * Verify an ordered run of receipts links back to itself correctly.
 *
 * Returns the index of the first broken link, or -1 when the chain is intact.
 */
export function findChainBreak(receipts: Receipt[]): number {
  for (let i = 0; i < receipts.length; i++) {
    const expectedPrev = i === 0 ? receipts[0].prevHash : hashReceipt(receipts[i - 1]);
    if (receipts[i].prevHash.toLowerCase() !== expectedPrev.toLowerCase()) {
      return i;
    }
  }
  return -1;
}

export function chainIsIntact(receipts: Receipt[]): boolean {
  return findChainBreak(receipts) === -1;
}

/** Head of the chain — what the next receipt should link to. */
export function chainHead(receipts: Receipt[]): Hex {
  if (receipts.length === 0) return GENESIS_LINK;
  return hashReceipt(receipts[receipts.length - 1]);
}
