/**
 * Assertion sources used in this file:
 *   issue     — KeeperHub #1840: a reused idempotency key replays a cached
 *               failure, so a retry under that key can never resubmit
 *   contract  — behaviour declared in src/idempotency.ts
 *   invariant — properties the key derivation must hold for retries to work
 */
import { describe, expect, it } from 'vitest';
import { keccak256, stringToHex } from 'viem';
import { idempotencyKey, keysAreWedged, unsafeStaticKey } from '../src/idempotency.js';

const INTENT = keccak256(stringToHex('some-intent'));
const OTHER_INTENT = keccak256(stringToHex('other-intent'));

describe('idempotencyKey', () => {
  it('is deterministic for the same intent and attempt', () => {
    // blindfold: contract — the key is a pure function of (intentHash, attempt)
    expect(idempotencyKey(INTENT, 0)).toBe(idempotencyKey(INTENT, 0));
  });

  /**
   * The whole point. If attempt 1 reused attempt 0's key, KeeperHub would
   * replay attempt 0's stored failure and never resubmit.
   */
  it('differs across attempts for the same intent', () => {
    const keys = [0, 1, 2, 3].map((attempt) => idempotencyKey(INTENT, attempt));

    // blindfold: issue — KeeperHub #1840, distinct per-attempt keys are what make a retry an actual resubmission
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('differs across intents for the same attempt', () => {
    // blindfold: invariant — two different intents must never share a key, or one would dedupe the other away
    expect(idempotencyKey(INTENT, 0)).not.toBe(idempotencyKey(OTHER_INTENT, 0));
  });

  it('is case-insensitive in the intent hash', () => {
    const upper = INTENT.toUpperCase().replace('0X', '0x') as `0x${string}`;

    // blindfold: contract — idempotencyKey lowercases the hash before hashing, so casing cannot fork the key
    expect(idempotencyKey(upper, 0)).toBe(idempotencyKey(INTENT, 0));
  });

  it('carries a greppable prefix', () => {
    // blindfold: contract — the `assay-` prefix is documented so keys are findable in KeeperHub's logs
    expect(idempotencyKey(INTENT, 0).startsWith('assay-')).toBe(true);
  });

  it('rejects a negative or non-integer attempt', () => {
    // blindfold: contract — attempt is declared as a non-negative integer and validated
    expect(() => idempotencyKey(INTENT, -1)).toThrow();
    expect(() => idempotencyKey(INTENT, 1.5)).toThrow();
  });
});

describe('unsafeStaticKey — the bug, kept for the gauntlet', () => {
  /**
   * Exported deliberately so scripts/gauntlet can poison a retry loop and the
   * reconciler's liveness check can be demonstrated catching it.
   */
  it('produces the same key on every attempt', () => {
    // blindfold: issue — KeeperHub #1840, this reproduces the wedge: one key for every attempt
    expect(unsafeStaticKey(INTENT)).toBe(unsafeStaticKey(INTENT));
  });

  it('is distinguishable from the safe key', () => {
    // blindfold: invariant — the unsafe helper must never collide with the production derivation
    expect(unsafeStaticKey(INTENT)).not.toBe(idempotencyKey(INTENT, 0));
  });
});

describe('keysAreWedged', () => {
  it('flags a run of identical keys', () => {
    const wedged = [0, 1, 2].map(() => unsafeStaticKey(INTENT));

    // blindfold: contract — keysAreWedged reports true when more than one attempt shares a single key
    expect(keysAreWedged(wedged)).toBe(true);
  });

  it('accepts distinct per-attempt keys', () => {
    const healthy = [0, 1, 2].map((attempt) => idempotencyKey(INTENT, attempt));

    // blindfold: contract — distinct keys can always resubmit, so they are never wedged
    expect(keysAreWedged(healthy)).toBe(false);
  });

  it('does not flag a single attempt', () => {
    expect(keysAreWedged([idempotencyKey(INTENT, 0)])).toBe(false);
    expect(keysAreWedged([])).toBe(false);
  });
});

/**
 * One intent produces three different KeeperHub requests: the commitment, the
 * action, and the receipt. They must not share a key.
 *
 * Observed live: committing and then acting on the same intent hash returned
 * `Idempotency-Key was reused with a different request payload`, and the action
 * never reached the chain — the cycle reported UNPROVEN for a transfer that
 * KeeperHub had simply refused to accept.
 */
describe('idempotencyKey — scope separation', () => {
  const intentHash = `0x${'11'.repeat(32)}` as const;

  it('gives the commit, action and receipt distinct keys for one intent', () => {
    const keys = [
      idempotencyKey(intentHash, 0, 'commit'),
      idempotencyKey(intentHash, 0, 'action'),
      idempotencyKey(intentHash, 0, 'receipt'),
    ];

    // blindfold: invariant — three different request payloads under one intent hash;
    // sharing a key makes KeeperHub reject the second as a payload conflict.
    expect(new Set(keys).size).toBe(3);
  });

  it('still varies by attempt within a scope', () => {
    const keys = [0, 1, 2].map((attempt) => idempotencyKey(intentHash, attempt, 'commit'));

    // blindfold: issue — KeeperHub #1840; scoping must not undo per-attempt keying,
    // which is what makes a retry an actual resubmission.
    expect(new Set(keys).size).toBe(3);
  });

  it('defaults to the action scope so the value-moving call keeps one stable key', () => {
    // blindfold: contract — idempotencyKey's declared default parameter is 'action'.
    expect(idempotencyKey(intentHash, 0)).toBe(idempotencyKey(intentHash, 0, 'action'));
    expect(idempotencyKey(intentHash, 0)).not.toBe(idempotencyKey(intentHash, 0, 'commit'));
  });
});
