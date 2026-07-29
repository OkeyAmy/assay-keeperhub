import type { Hex } from 'viem';
import { idempotencyKey, type KeyScope } from '@assay/core';
import { KeeperHubError } from './client.js';
import type { ExecuteAck } from './execute.js';
import type { AttemptRecord } from './audit.js';

/**
 * Retry loop for a single intent.
 *
 * The important property: **every attempt gets its own idempotency key**,
 * derived from `(intentHash, attemptNumber)`.
 *
 * KeeperHub stores the response for a key and replays it for 24 hours. That is
 * correct behaviour for deduplication and catastrophic for recovery — if the
 * stored response was a failure, a retry under the same key replays the failure
 * without resubmitting, and the loop spins forever against a cache. That is
 * KeeperHub issue #1840. Keying per attempt means attempt N+1 is a genuinely
 * new request, while a repeat of attempt N still deduplicates correctly.
 *
 * Gas escalates across attempts via `gasLimitMultiplier`, so a transaction that
 * stalled on a congestion spike gets more headroom rather than the same bid.
 */
export async function executeWithRetry(
  intentHash: Hex,
  chainId: number,
  submit: (key: string, gasLimitMultiplier: string) => Promise<ExecuteAck>,
  options: RetryOptions = {},
): Promise<RetryOutcome> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 2_000;
  const baseMultiplier = options.baseGasMultiplier ?? 1.2;
  const multiplierStep = options.gasMultiplierStep ?? 0.3;
  const sleep = options.sleep ?? defaultSleep;

  const attempts: AttemptRecord[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = idempotencyKey(intentHash, attempt, options.scope ?? 'action');
    const multiplier = (baseMultiplier + multiplierStep * attempt).toFixed(2);
    const startedAt = Date.now();

    try {
      const ack = await submit(key, multiplier);
      attempts.push({ idempotencyKey: key, chainId, ack, at: startedAt });

      // A replay means KeeperHub returned a stored response rather than
      // executing. With per-attempt keys this should only happen when we
      // genuinely repeated ourselves, so it is recorded and the loop stops
      // rather than hammering a cache.
      return { attempts, ack, wedged: false };
    } catch (error) {
      if (!(error instanceof KeeperHubError)) throw error;

      attempts.push({
        idempotencyKey: key,
        chainId,
        error: error.message,
        at: startedAt,
      });

      // Client mistakes do not become correct by being repeated.
      if (!error.isTransient && !error.isIdempotencyConflict) {
        return { attempts, wedged: false, terminalError: error };
      }

      // A conflict means this key already carries a different request body.
      // Retrying the same key can only ever replay; the next attempt's key is
      // different, so the loop continues rather than aborting.
      if (error.isIdempotencyConflict && attempt === maxAttempts - 1) {
        return { attempts, wedged: true, terminalError: error };
      }

      if (error.isSpendingCapExceeded || error.isWalletNotConfigured) {
        return { attempts, wedged: false, terminalError: error };
      }

      if (attempt === maxAttempts - 1) {
        return { attempts, wedged: false, terminalError: error };
      }

      // Honour Retry-After when rate limited; otherwise exponential backoff.
      const retryAfterMs = error.rateLimit?.retryAfterSeconds
        ? error.rateLimit.retryAfterSeconds * 1000
        : undefined;
      await sleep(retryAfterMs ?? baseDelayMs * 2 ** attempt);
    }
  }

  return { attempts, wedged: false };
}

export interface RetryOptions {
  /**
   * Which of the cycle's transactions this is. One intent produces a commit, an
   * action and a receipt; without distinct scopes they collide on one key.
   */
  scope?: KeyScope;
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Gas limit multiplier for the first attempt. */
  baseGasMultiplier?: number;
  /** Added to the multiplier on each subsequent attempt. */
  gasMultiplierStep?: number;
  /** Injectable so tests do not spend real time. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RetryOutcome {
  attempts: AttemptRecord[];
  /** Present when some attempt was accepted. */
  ack?: ExecuteAck;
  /** True when the loop could not make progress because of key reuse. */
  wedged: boolean;
  terminalError?: KeeperHubError;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
