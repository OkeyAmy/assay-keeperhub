import { keccak256, toHex, type Hex } from 'viem';

/**
 * Derive the idempotency key for a specific submission attempt.
 *
 * KeeperHub issue #1840: a reused idempotency key replays a cached response,
 * and if that cached response was a failure, every subsequent "retry" replays
 * the failure without ever resubmitting. The retry loop looks healthy and the
 * transaction never lands.
 *
 * The fix is to make the key a function of (intent, attempt) rather than of
 * intent alone. Attempt 0 and attempt 1 are then different keys, so attempt 1
 * genuinely resubmits, while replaying attempt 0 with the same attempt number
 * still deduplicates the way idempotency is supposed to.
 *
 * Do not simplify this to `keccak256(intentHash)`. That is the bug.
 *
 * `scope` separates the different transactions a single cycle sends about the
 * *same* intent. Committing the intent hash, performing the action and writing
 * the receipt are three different payloads; keying them all off the intent hash
 * alone makes the second one collide with the first, and KeeperHub correctly
 * rejects it with `Idempotency-Key was reused with a different request payload`.
 * The failure is confusing because the key derivation looks right in isolation —
 * it is only wrong once one intent produces more than one request.
 */
export function idempotencyKey(
  intentHash: Hex,
  attempt: number,
  scope: KeyScope = 'action',
): string {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error(`attempt must be a non-negative integer, got ${attempt}`);
  }
  const digest = keccak256(toHex(`${scope}:${intentHash.toLowerCase()}:${attempt}`));
  // KeeperHub keys are opaque strings; a prefix makes them greppable in their logs.
  return `assay-${digest.slice(2, 34)}`;
}

/**
 * Which of a cycle's transactions a key belongs to.
 *
 * Every distinct request payload derived from one intent needs its own scope.
 */
export type KeyScope = 'commit' | 'action' | 'receipt';

/**
 * The key an unsafe implementation would produce.
 *
 * Exported so `scripts/gauntlet` can deliberately poison a retry loop and the
 * reconciler's liveness check can be shown catching it. Never call this from
 * the execution path.
 */
export function unsafeStaticKey(intentHash: Hex): string {
  return `assay-${keccak256(toHex(intentHash.toLowerCase())).slice(2, 34)}`;
}

/** True when a set of attempt keys can never recover, because they never change. */
export function keysAreWedged(keys: string[]): boolean {
  return keys.length > 1 && new Set(keys).size === 1;
}
