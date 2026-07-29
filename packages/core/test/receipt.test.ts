/**
 * Assertion sources used in this file:
 *   golden    — vector produced by the Solidity side via `cast`, pinned here so
 *               the two implementations cannot drift apart silently
 *   contract  — behaviour declared in src/receipt.ts / src/verdict.ts
 *   invariant — chain properties the receipt log is supposed to guarantee
 */
import { describe, expect, it } from 'vitest';
import { keccak256, stringToHex, type Hex } from 'viem';
import {
  buildReceipt,
  chainHead,
  chainIsIntact,
  findChainBreak,
  GENESIS_LINK,
  hashReason,
  hashReceipt,
  ZERO_HASH,
  type Receipt,
} from '../src/receipt.js';
import { VERDICT_CODE, verdictFromCode, type Verdict } from '../src/verdict.js';

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    intentHash: keccak256(stringToHex('i')),
    txHash: keccak256(stringToHex('t')),
    verdict: VERDICT_CODE.VERIFIED,
    reasonHash: hashReason('ALL_CHECKS_PASSED'),
    prevHash: GENESIS_LINK,
    observedAt: 1_700_000_000n,
    ...overrides,
  };
}

describe('hashReceipt — cross-language agreement', () => {
  /**
   * Produced with:
   *   cast keccak $(cast abi-encode \
   *     "f(bytes32,bytes32,uint8,bytes32,bytes32,uint64)" \
   *     $(cast keccak "i") $(cast keccak "t") 1 \
   *     $(cast keccak "ALL_CHECKS_PASSED") 0x00..00 1700000000)
   *
   * If this fails, a chain assembled in TypeScript will be rejected by
   * ReceiptRegistry.write, so the two encodings must never diverge.
   */
  it('matches the vector produced by ReceiptRegistry._hashReceipt', () => {
    // blindfold: golden — computed by `cast` against the Solidity abi.encode layout, see comment above
    expect(hashReceipt(receipt())).toBe(
      '0x82469deff204bfdd4c3c2dfd76f41a6a13e8ead9fecba25923cf8aaf9075fa17',
    );
  });

  it('changes when any field changes', () => {
    const base = hashReceipt(receipt());

    // blindfold: invariant — every field is part of the preimage, so none may be silently mutable
    expect(hashReceipt(receipt({ verdict: VERDICT_CODE.DIVERGENT }))).not.toBe(base);
    expect(hashReceipt(receipt({ observedAt: 1_700_000_001n }))).not.toBe(base);
    expect(hashReceipt(receipt({ txHash: keccak256(stringToHex('u')) }))).not.toBe(base);
    expect(hashReceipt(receipt({ prevHash: keccak256(stringToHex('p')) }))).not.toBe(base);
  });
});

describe('buildReceipt', () => {
  function verdict(overrides: Partial<Verdict> = {}): Verdict {
    return {
      kind: 'VERIFIED',
      reason: 'ALL_CHECKS_PASSED',
      checks: [],
      intentHash: keccak256(stringToHex('i')),
      txHash: keccak256(stringToHex('t')),
      observedAt: 1_700_000_000_000,
      ...overrides,
    };
  }

  it('encodes the verdict kind as its numeric code', () => {
    // blindfold: contract — VERDICT_CODE in src/verdict.ts is declared as the onchain encoding
    expect(buildReceipt(verdict()).verdict).toBe(VERDICT_CODE.VERIFIED);
    expect(buildReceipt(verdict({ kind: 'DIVERGENT' })).verdict).toBe(VERDICT_CODE.DIVERGENT);
  });

  it('converts the millisecond timestamp to seconds', () => {
    // blindfold: contract — Receipt.observedAt is documented as unix seconds; Verdict.observedAt is millis
    expect(buildReceipt(verdict()).observedAt).toBe(1_700_000_000n);
  });

  /** KeeperHub issue #1784: executions can legitimately have no transaction hash. */
  it('substitutes the zero hash when no transaction was reported', () => {
    const built = buildReceipt(verdict({ kind: 'UNPROVEN', reason: 'TX_HASH_ABSENT', txHash: undefined }));

    // blindfold: issue — KeeperHub #1784, a missing txHash must still produce a recordable receipt
    expect(built.txHash).toBe(ZERO_HASH);
    expect(built.verdict).toBe(VERDICT_CODE.UNPROVEN);
  });

  it('links to the supplied previous hash, defaulting to genesis', () => {
    const prev = keccak256(stringToHex('previous'));

    // blindfold: contract — buildReceipt's prevHash parameter defaults to GENESIS_LINK
    expect(buildReceipt(verdict()).prevHash).toBe(GENESIS_LINK);
    expect(buildReceipt(verdict(), prev).prevHash).toBe(prev);
  });
});

describe('chain integrity', () => {
  /** Build a correctly linked run of `n` receipts. */
  function makeChain(n: number): Receipt[] {
    const out: Receipt[] = [];
    let prev: Hex = GENESIS_LINK;
    for (let i = 0; i < n; i++) {
      const r = receipt({ intentHash: keccak256(stringToHex(`i${i}`)), prevHash: prev });
      out.push(r);
      prev = hashReceipt(r);
    }
    return out;
  }

  it('reports an intact chain', () => {
    // blindfold: contract — findChainBreak returns -1 for a chain with no broken link
    expect(findChainBreak(makeChain(5))).toBe(-1);
    expect(chainIsIntact(makeChain(5))).toBe(true);
  });

  it('treats an empty chain as intact', () => {
    expect(chainIsIntact([])).toBe(true);
  });

  /**
   * The property the chain exists for: a verifier that publishes only its
   * convenient results leaves a visible hole.
   */
  it('detects a dropped receipt', () => {
    const chain = makeChain(5);
    const withHole = [...chain.slice(0, 2), ...chain.slice(3)];

    // blindfold: invariant — removing a link must break every link after it, which is the tamper-evidence claim
    expect(findChainBreak(withHole)).toBe(2);
    expect(chainIsIntact(withHole)).toBe(false);
  });

  it('detects a reordered chain', () => {
    const chain = makeChain(4);
    const swapped = [chain[0], chain[2], chain[1], chain[3]];

    // blindfold: invariant — link order is fixed by the hash pointers, so reordering must be detectable
    expect(chainIsIntact(swapped)).toBe(false);
  });

  it('detects a tampered receipt body', () => {
    const chain = makeChain(3);
    chain[1] = { ...chain[1], verdict: VERDICT_CODE.VERIFIED, txHash: keccak256(stringToHex('forged')) };

    // blindfold: invariant — editing a receipt changes its hash, orphaning its successor
    expect(findChainBreak(chain)).toBe(2);
  });

  it('reports genesis as the head of an empty chain', () => {
    // blindfold: contract — chainHead documents GENESIS_LINK as the empty-chain head
    expect(chainHead([])).toBe(GENESIS_LINK);
  });

  it('reports the hash of the last receipt as the head', () => {
    const chain = makeChain(3);
    // blindfold: contract — the next receipt links to hashReceipt of the current last element
    expect(chainHead(chain)).toBe(hashReceipt(chain[2]));
  });
});

describe('verdict codes', () => {
  it('round-trips every kind through its numeric code', () => {
    for (const kind of Object.keys(VERDICT_CODE) as (keyof typeof VERDICT_CODE)[]) {
      // blindfold: contract — verdictFromCode is declared as the inverse of VERDICT_CODE
      expect(verdictFromCode(VERDICT_CODE[kind])).toBe(kind);
    }
  });

  it('rejects a code outside the known range', () => {
    // blindfold: contract — ReceiptRegistry.write rejects verdict 0 and >4, so the decoder must agree
    expect(() => verdictFromCode(0)).toThrow();
    expect(() => verdictFromCode(9)).toThrow();
  });
});
