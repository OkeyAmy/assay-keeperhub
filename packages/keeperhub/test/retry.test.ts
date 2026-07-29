/**
 * Assertion sources used in this file:
 *   issue     — KeeperHub #1840 (idempotency replay wedges retries) and the
 *               idempotency semantics in docs/api/direct-execution.md
 *   doc       — docs/api/direct-execution.md: 409 codes, Retry-After, rate limits
 *   contract  — behaviour declared in src/retry.ts
 *   invariant — properties a retry loop must hold to be able to recover
 */
import { describe, expect, it } from 'vitest';
import { keccak256, stringToHex } from 'viem';
import { idempotencyKey } from '@assay/core';
import { KeeperHubError } from '../src/client.js';
import { executeWithRetry } from '../src/retry.js';
import type { ExecuteAck } from '../src/execute.js';

const INTENT = keccak256(stringToHex('intent'));
const CHAIN = 11155111;

/** Never actually sleeps; keeps backoff assertions instant and deterministic. */
const noSleep = async () => {};

function ack(key: string, replayed = false): ExecuteAck {
  return { executionId: 'direct_1', status: 'completed', idempotencyKey: key, replayed };
}

describe('executeWithRetry — success', () => {
  it('returns the ack from the first attempt when it lands', async () => {
    const keys: string[] = [];
    const outcome = await executeWithRetry(
      INTENT,
      CHAIN,
      async (key) => {
        keys.push(key);
        return ack(key);
      },
      { sleep: noSleep },
    );

    // blindfold: contract — a successful submission short-circuits the loop
    expect(keys).toHaveLength(1);
    // blindfold: contract — the outcome carries through the ack returned by submit(), value set by the local `ack` helper
    expect(outcome.ack?.executionId).toBe('direct_1');
    expect(outcome.wedged).toBe(false);
  });

  it('uses the derived per-attempt key for the first attempt', async () => {
    let seen = '';
    await executeWithRetry(
      INTENT,
      CHAIN,
      async (key) => {
        seen = key;
        return ack(key);
      },
      { sleep: noSleep },
    );

    // blindfold: contract — keys come from @assay/core idempotencyKey(intentHash, attempt)
    expect(seen).toBe(idempotencyKey(INTENT, 0));
  });
});

describe('executeWithRetry — key derivation (KeeperHub #1840)', () => {
  /**
   * The property the whole fix rests on. If attempts shared a key, KeeperHub
   * would replay attempt 0's stored failure forever and never resubmit.
   */
  it('gives every attempt a distinct idempotency key', async () => {
    const keys: string[] = [];
    await executeWithRetry(
      INTENT,
      CHAIN,
      async (key) => {
        keys.push(key);
        throw new KeeperHubError('upstream unavailable', 503);
      },
      { maxAttempts: 4, sleep: noSleep },
    );

    // blindfold: issue — KeeperHub #1840, distinct keys are what make a retry an actual resubmission
    expect(keys).toHaveLength(4);
    // blindfold: issue — KeeperHub #1840, all four keys must be distinct or attempts 1-3 would replay attempt 0's cached failure
    expect(new Set(keys).size).toBe(4);
  });

  it('derives keys matching idempotencyKey for each attempt index', async () => {
    const keys: string[] = [];
    await executeWithRetry(
      INTENT,
      CHAIN,
      async (key) => {
        keys.push(key);
        throw new KeeperHubError('upstream unavailable', 503);
      },
      { maxAttempts: 3, sleep: noSleep },
    );

    // blindfold: contract — retry.ts documents the key as idempotencyKey(intentHash, attempt)
    expect(keys).toEqual([0, 1, 2].map((i) => idempotencyKey(INTENT, i)));
  });
});

describe('executeWithRetry — gas escalation', () => {
  /** A stalled transaction needs more headroom, not the same bid repeated. */
  it('raises the gas limit multiplier on each attempt', async () => {
    const multipliers: string[] = [];
    await executeWithRetry(
      INTENT,
      CHAIN,
      async (_key, multiplier) => {
        multipliers.push(multiplier);
        throw new KeeperHubError('timeout', 504);
      },
      { maxAttempts: 3, baseGasMultiplier: 1.2, gasMultiplierStep: 0.3, sleep: noSleep },
    );

    // blindfold: contract — retry.ts computes base + step * attempt, fixed to 2dp
    expect(multipliers).toEqual(['1.20', '1.50', '1.80']);
  });
});

describe('executeWithRetry — error classification', () => {
  it('stops immediately on a non-transient client error', async () => {
    let calls = 0;
    const outcome = await executeWithRetry(
      INTENT,
      CHAIN,
      async () => {
        calls++;
        throw new KeeperHubError('Missing required field', 400);
      },
      { maxAttempts: 5, sleep: noSleep },
    );

    // blindfold: invariant — a malformed request does not become valid by being repeated
    expect(calls).toBe(1);
    // blindfold: doc — docs/api/direct-execution.md lists 400 for invalid request parameters
    expect(outcome.terminalError?.httpStatus).toBe(400);
  });

  it('stops immediately when the daily spending cap is exceeded', async () => {
    let calls = 0;
    const outcome = await executeWithRetry(
      INTENT,
      CHAIN,
      async () => {
        calls++;
        throw new KeeperHubError('Daily spending cap exceeded', 403);
      },
      { maxAttempts: 5, sleep: noSleep },
    );

    // blindfold: doc — docs/api/direct-execution.md returns 403 "Daily spending cap exceeded"; retrying cannot help
    expect(calls).toBe(1);
    expect(outcome.terminalError?.isSpendingCapExceeded).toBe(true);
  });

  it('stops immediately when the wallet is not configured', async () => {
    let calls = 0;
    await executeWithRetry(
      INTENT,
      CHAIN,
      async () => {
        calls++;
        throw new KeeperHubError('Wallet not configured', 422, { code: 'WALLET_NOT_CONFIGURED' });
      },
      { maxAttempts: 5, sleep: noSleep },
    );

    // blindfold: doc — docs/api/direct-execution.md documents 422 WALLET_NOT_CONFIGURED as a setup error
    expect(calls).toBe(1);
  });

  it('retries a server error up to the attempt limit', async () => {
    let calls = 0;
    const outcome = await executeWithRetry(
      INTENT,
      CHAIN,
      async () => {
        calls++;
        throw new KeeperHubError('internal error', 500);
      },
      { maxAttempts: 3, sleep: noSleep },
    );

    // blindfold: contract — 5xx is classified transient by KeeperHubError.isTransient
    expect(calls).toBe(3);
    // blindfold: contract — KeeperHubError.isTransient treats >=500 as retryable, so 500 survives to the terminal error
    expect(outcome.terminalError?.httpStatus).toBe(500);
  });

  it('retries while an earlier request under the key is still in progress', async () => {
    let calls = 0;
    await executeWithRetry(
      INTENT,
      CHAIN,
      async (key) => {
        calls++;
        if (calls < 2) {
          throw new KeeperHubError('still running', 409, { code: 'idempotency_in_progress' });
        }
        return ack(key);
      },
      { maxAttempts: 3, sleep: noSleep },
    );

    // blindfold: doc — docs/api/direct-execution.md says idempotency_in_progress should be retried shortly
    expect(calls).toBe(2);
  });

  it('reports a wedge when the final attempt still conflicts on its key', async () => {
    const outcome = await executeWithRetry(
      INTENT,
      CHAIN,
      async () => {
        throw new KeeperHubError('key already used', 409, {
          code: 'idempotency_conflict',
          originalExecutionId: 'direct_original',
        });
      },
      { maxAttempts: 2, sleep: noSleep },
    );

    // blindfold: issue — KeeperHub #1840, an unresolvable key conflict means retries cannot recover
    expect(outcome.wedged).toBe(true);
    // blindfold: doc — docs/api/direct-execution.md returns originalExecutionId alongside idempotency_conflict
    expect(outcome.terminalError?.originalExecutionId).toBe('direct_original');
  });

  it('recovers when a later attempt succeeds after transient failures', async () => {
    let calls = 0;
    const outcome = await executeWithRetry(
      INTENT,
      CHAIN,
      async (key) => {
        calls++;
        if (calls < 3) throw new KeeperHubError('bad gateway', 502);
        return ack(key);
      },
      { maxAttempts: 4, sleep: noSleep },
    );

    // blindfold: invariant — distinct per-attempt keys let attempt 3 genuinely resubmit rather than replay
    expect(outcome.ack?.idempotencyKey).toBe(idempotencyKey(INTENT, 2));
    expect(outcome.wedged).toBe(false);
  });
});

describe('executeWithRetry — backoff', () => {
  it('honours Retry-After when rate limited', async () => {
    const waits: number[] = [];
    let calls = 0;

    await executeWithRetry(
      INTENT,
      CHAIN,
      async (key) => {
        calls++;
        if (calls < 2) {
          throw new KeeperHubError('rate limited', 429, {
            rateLimit: { retryAfterSeconds: 7 },
          });
        }
        return ack(key);
      },
      { maxAttempts: 3, sleep: async (ms) => void waits.push(ms) },
    );

    // blindfold: doc — docs/api/direct-execution.md: a 429 carries Retry-After in seconds
    expect(waits).toEqual([7000]);
  });

  it('backs off exponentially when no Retry-After is supplied', async () => {
    const waits: number[] = [];

    await executeWithRetry(
      INTENT,
      CHAIN,
      async () => {
        throw new KeeperHubError('unavailable', 503);
      },
      { maxAttempts: 3, baseDelayMs: 1000, sleep: async (ms) => void waits.push(ms) },
    );

    // blindfold: contract — retry.ts uses baseDelayMs * 2 ** attempt between attempts
    expect(waits).toEqual([1000, 2000]);
  });

  it('records every attempt, including the failed ones', async () => {
    const outcome = await executeWithRetry(
      INTENT,
      CHAIN,
      async () => {
        throw new KeeperHubError('unavailable', 503);
      },
      { maxAttempts: 3, sleep: noSleep },
    );

    // blindfold: invariant — the audit trail must show the whole submission history, not just the last try
    expect(outcome.attempts).toHaveLength(3);
    expect(outcome.attempts.every((a) => a.error === 'unavailable')).toBe(true);
  });

  it('propagates a non-KeeperHub error rather than swallowing it', async () => {
    await expect(
      executeWithRetry(
        INTENT,
        CHAIN,
        async () => {
          throw new TypeError('programmer error');
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow(TypeError);
  });
});
