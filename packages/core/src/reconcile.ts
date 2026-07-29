import type { Hex } from 'viem';
import { calldataMatchesIntent, isExpired, hashIntent, ZERO_ADDRESS, type Intent } from './intent.js';
import type { AuditTrail, ChainObservation, ObservedBalanceDelta } from './observation.js';
import {
  isWorse,
  kindForReason,
  type CheckResult,
  type Verdict,
  type VerdictKind,
  type VerdictReason,
} from './verdict.js';

export interface ReconcileOptions {
  /** Current time in unix seconds, for the expiry check. Injected so tests are deterministic. */
  nowSeconds?: bigint;
  /** Current time in unix milliseconds, stamped onto the verdict. */
  nowMillis?: number;
}

/**
 * Decide whether an execution did what the agent committed to.
 *
 * Pure. No I/O, no clock, no network. Every input is passed in, which is what
 * makes the four failure modes in `scripts/gauntlet` reproducible as unit
 * tests rather than as things you have to take on faith from a demo video.
 *
 * The three arguments come from three different places on purpose:
 *   - `intent`   is what the agent committed onchain, before execution
 *   - `audit`    is what the executor says it did
 *   - `observed` is what an independent RPC path saw
 *
 * A verifier that sourced `observed` from the executor would agree with it by
 * construction. Keeping them separate is the entire point of the product, and
 * `scripts/check-boundaries.mjs` enforces that this file cannot import an
 * execution provider.
 */
export function reconcile(
  intent: Intent,
  audit: AuditTrail,
  observed: ChainObservation,
  options: ReconcileOptions = {},
): Verdict {
  const nowSeconds = options.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  const nowMillis = options.nowMillis ?? Date.now();
  const intentHash = hashIntent(intent);

  const checks: CheckResult[] = [];

  const existence = checkExistence(intent, audit, observed, nowSeconds);
  checks.push(existence);

  // Conformance, effect and liveness all need a mined transaction to reason
  // about. Running them without one would produce confident-looking noise.
  const haveMinedTx = existence.passed && observed.transaction !== undefined;

  if (haveMinedTx) {
    checks.push(checkConformance(intent, observed));
    checks.push(checkEffect(intent, audit, observed));
  }
  checks.push(checkLiveness(audit));

  return collapse(checks, intentHash, audit, observed, nowMillis);
}

/** Is there a transaction at all, and did it get mined? */
function checkExistence(
  intent: Intent,
  audit: AuditTrail,
  observed: ChainObservation,
  nowSeconds: bigint,
): CheckResult {
  const name = 'existence' as const;

  if (audit.status === 'cancelled') {
    return fail(name, 'NO_EXECUTION_ATTEMPTED', 'executor reports the run was cancelled');
  }

  if (audit.simulation && !audit.simulation.succeeded && !audit.txHash) {
    return fail(
      name,
      'SIMULATION_REJECTED',
      audit.simulation.revertReason ?? 'simulation failed before submission',
    );
  }

  if (audit.attempts.length === 0 && !audit.txHash) {
    // Nothing was ever submitted. If the intent has also expired, that is the
    // more informative explanation of why.
    if (isExpired(intent, nowSeconds)) {
      return fail(name, 'INTENT_EXPIRED', 'deadline passed with no submission attempt');
    }
    return fail(name, 'NO_EXECUTION_ATTEMPTED', 'executor recorded no submission attempts');
  }

  if (!observed.available) {
    return fail(name, 'OBSERVER_UNAVAILABLE', 'no independent RPC provider could be reached');
  }

  if (observed.agreementCount < observed.quorumRequired) {
    return fail(
      name,
      'OBSERVER_QUORUM_FAILED',
      `${observed.agreementCount} of ${observed.quorumRequired} required providers agreed`,
    );
  }

  // KeeperHub issue #1784: the execute response can omit txHash entirely on
  // sponsored and 7702 executions. That is not an error and not a success —
  // it is an absence of evidence, and it is reported as exactly that.
  if (!audit.txHash) {
    return fail(
      name,
      'TX_HASH_ABSENT',
      'executor reported no transaction hash, so the claim cannot be checked',
    );
  }

  if (!observed.transaction) {
    return fail(
      name,
      'TX_NOT_FOUND_ONCHAIN',
      `executor claims ${audit.txHash} but no independent provider can see it`,
    );
  }

  if (observed.transaction.status === undefined) {
    return fail(name, 'TX_NOT_MINED_YET', 'transaction is visible but not yet mined');
  }

  return pass(name);
}

/** Does the mined transaction match what was committed to? */
function checkConformance(intent: Intent, observed: ChainObservation): CheckResult {
  const name = 'conformance' as const;
  const tx = observed.transaction!;

  if (tx.chainId !== intent.chainId) {
    return fail(name, 'CHAIN_MISMATCH', `committed chain ${intent.chainId}, executed on ${tx.chainId}`);
  }

  const intendedTarget = intent.target.toLowerCase();
  const actualTarget = tx.to?.toLowerCase() ?? null;
  if (actualTarget !== intendedTarget) {
    // A relayed execution — KeeperHub's sponsored/7702 path — puts the relayer
    // in `to` and reaches the intended target as an inner call. The top-level
    // fields describe the wrapper, so comparing them to the intent would call
    // every honest sponsored execution a divergence.
    //
    // Being called indirectly is only credible if the target actually appears
    // in the receipt. If it never emitted anything, this is a real mismatch.
    const logs = tx.logs ?? [];
    const targetEmitted = logs.some((log) => log.address.toLowerCase() === intendedTarget);
    if (!targetEmitted) {
      return fail(
        name,
        'TARGET_MISMATCH',
        `committed to ${intendedTarget}, called ${actualTarget ?? 'contract creation'}`,
      );
    }
    return checkRelayedConformance(intent, observed, intendedTarget);
  }

  if (tx.value !== intent.value) {
    return fail(name, 'VALUE_MISMATCH', `committed ${intent.value} wei, sent ${tx.value} wei`);
  }

  // The check that catches template-binding bugs, stale {{...}} references and
  // decimal errors — the failures that still return status: success.
  if (!calldataMatchesIntent(intent, tx.input)) {
    return fail(
      name,
      'CALLDATA_MISMATCH',
      'executed calldata does not match the committed intent',
    );
  }

  return pass(name);
}

/**
 * Conformance for an execution that reached its target through a relayer.
 *
 * The calldata comparison is unavailable here — the bytes on the wire belong to
 * the wrapper — so this is the one path where the usual evidence is missing.
 * That makes it exactly the place a verifier degenerates into a rubber stamp,
 * so the rule is deliberately inverted: rather than waiving the check, it
 * demands the intent have declared enough falsifiable effect that the `effect`
 * check can carry the whole weight of the conclusion.
 *
 * An intent that declared no balance bounds and no required events is not
 * "close enough" — nothing about it is checkable through a relayer, and the
 * honest answer is UNPROVEN.
 */
function checkRelayedConformance(
  intent: Intent,
  observed: ChainObservation,
  intendedTarget: string,
): CheckResult {
  const name = 'conformance' as const;
  const tx = observed.transaction!;
  const { requiredTopics, balanceDeltas } = intent.bounds;

  // Native value cannot be attributed to the inner call without traces.
  if (intent.value !== 0n) {
    return fail(
      name,
      'RELAYED_EFFECT_UNDECLARED',
      `intent moves ${intent.value} wei through a relayer; native value cannot be attributed to the inner call`,
    );
  }

  if (requiredTopics.length === 0 || balanceDeltas.length === 0) {
    return fail(
      name,
      'RELAYED_EFFECT_UNDECLARED',
      'relayed execution and the intent declared no event or balance bounds, so nothing about it is independently checkable',
    );
  }

  // Every required event must have come from the target itself. Without this,
  // an unrelated contract emitting the same signature would satisfy the check.
  for (const topic of requiredTopics) {
    const fromTarget = (tx.logs ?? []).some(
      (log) =>
        log.address.toLowerCase() === intendedTarget && log.topic.toLowerCase() === topic.toLowerCase(),
    );
    if (!fromTarget) {
      return fail(
        name,
        'REQUIRED_EVENT_MISSING',
        `${intendedTarget} did not emit required topic ${topic}`,
      );
    }
  }

  return {
    name,
    passed: true,
    detail: `relayed via ${tx.to ?? 'unknown'}; conformance established from ${intendedTarget}'s own events and the declared balance bounds, not from calldata`,
  };
}

/** Did the world actually change the way the intent said it would? */
function checkEffect(intent: Intent, audit: AuditTrail, observed: ChainObservation): CheckResult {
  const name = 'effect' as const;
  const tx = observed.transaction!;

  // The headline case: the executor says success, the chain says reverted.
  if (tx.status === 'reverted') {
    if (audit.status === 'success') {
      return fail(
        name,
        'REVERTED_BUT_REPORTED_SUCCESS',
        'executor reported success but the transaction reverted onchain',
      );
    }
    return fail(name, 'REVERTED_BUT_REPORTED_SUCCESS', 'transaction reverted onchain');
  }

  const { maxGasUsed, requiredTopics, balanceDeltas } = intent.bounds;

  if (maxGasUsed > 0n && tx.gasUsed !== undefined && tx.gasUsed > maxGasUsed) {
    return fail(name, 'GAS_EXCEEDED_BOUND', `used ${tx.gasUsed} gas, bound was ${maxGasUsed}`);
  }

  const seenTopics = new Set(tx.logTopics.map((t) => t.toLowerCase()));
  for (const topic of requiredTopics) {
    if (!seenTopics.has(topic.toLowerCase())) {
      return fail(name, 'REQUIRED_EVENT_MISSING', `expected event topic ${topic} was not emitted`);
    }
  }

  if (balanceDeltas.length > 0) {
    if (observed.balancesIncomplete) {
      return fail(
        name,
        'BALANCE_SNAPSHOT_MISSING',
        'balances could not be read on both sides of the transaction',
      );
    }

    for (const expected of balanceDeltas) {
      const actual = findDelta(observed.balanceDeltas, expected.token, expected.account);
      if (!actual) {
        return fail(
          name,
          'BALANCE_SNAPSHOT_MISSING',
          `no balance observation for ${expected.account} / ${expected.token}`,
        );
      }
      if (actual.delta < expected.min || actual.delta > expected.max) {
        return fail(
          name,
          'BALANCE_DELTA_OUT_OF_BOUNDS',
          `${expected.account} moved ${actual.delta}, expected [${expected.min}, ${expected.max}]`,
        );
      }
    }
  }

  // A successful transaction that declared effects, emitted no logs and moved
  // no balances did nothing. Some executors will still call that a success.
  const declaredAnyEffect = balanceDeltas.length > 0 || requiredTopics.length > 0;
  const movedNothing =
    tx.logCount === 0 && observed.balanceDeltas.every((d) => d.delta === 0n);
  if (declaredAnyEffect && movedNothing) {
    return fail(
      name,
      'NO_STATE_CHANGE_ON_SUCCESS',
      'transaction succeeded but produced no observable state change',
    );
  }

  return pass(name);
}

/**
 * Could the executor still recover, or is it wedged?
 *
 * KeeperHub issue #1840: reusing an idempotency key replays a *cached failure*,
 * so a retry that looks like a retry never actually resubmits. From the
 * outside it is indistinguishable from a slow failure, which is why it needs
 * its own check rather than being folded into existence.
 */
function checkLiveness(audit: AuditTrail): CheckResult {
  const name = 'liveness' as const;

  if (audit.attempts.length === 0) {
    return pass(name);
  }

  const failedReplays = audit.attempts.filter((a) => a.replayed && a.status === 'error');
  if (failedReplays.length > 0) {
    const landed = audit.attempts.some((a) => a.status === 'success');
    if (!landed) {
      return fail(
        name,
        'IDEMPOTENCY_WEDGE',
        `${failedReplays.length} attempt(s) replayed a cached failure and never resubmitted; ` +
          'retries under this key cannot recover',
      );
    }
  }

  // Distinct keys per attempt are what make recovery possible in the first
  // place. Repeats across attempts are the precondition for the wedge above.
  const keys = audit.attempts.map((a) => a.idempotencyKey).filter((k): k is string => !!k);
  if (keys.length > 1) {
    const unique = new Set(keys);
    const allFailed = audit.attempts.every((a) => a.status === 'error');
    if (unique.size === 1 && allFailed) {
      return fail(
        name,
        'IDEMPOTENCY_WEDGE',
        `${keys.length} attempts reused a single idempotency key and all failed`,
      );
    }
  }

  return pass(name);
}

function findDelta(
  deltas: ObservedBalanceDelta[],
  token: string,
  account: string,
): ObservedBalanceDelta | undefined {
  const t = token.toLowerCase();
  const a = account.toLowerCase();
  return deltas.find((d) => d.token.toLowerCase() === t && d.account.toLowerCase() === a);
}

function pass(name: CheckResult['name']): CheckResult {
  return { name, passed: true };
}

function fail(name: CheckResult['name'], reason: VerdictReason, detail: string): CheckResult {
  return { name, passed: false, reason, detail };
}

/**
 * Fold per-check results into a single verdict, keeping the worst outcome.
 *
 * Worst-wins rather than first-wins: a CALLDATA_MISMATCH found by conformance
 * must not be masked by an earlier check that merely came back UNPROVEN.
 */
function collapse(
  checks: CheckResult[],
  intentHash: Hex,
  audit: AuditTrail,
  observed: ChainObservation,
  nowMillis: number,
): Verdict {
  let kind: VerdictKind = 'VERIFIED';
  let reason: VerdictReason = 'ALL_CHECKS_PASSED';
  let detail: string | undefined;

  for (const check of checks) {
    if (check.passed || !check.reason) continue;
    const candidate = kindForReason(check.reason);
    if (isWorse(candidate, kind)) {
      kind = candidate;
      reason = check.reason;
      detail = check.detail;
    }
  }

  return {
    kind,
    reason,
    checks,
    intentHash,
    txHash: audit.txHash ?? observed.transaction?.hash,
    executionId: audit.executionId,
    observedAt: nowMillis,
    detail,
  };
}

/** Convenience for callers that only care whether it is safe to proceed. */
export function isVerified(verdict: Verdict): boolean {
  return verdict.kind === 'VERIFIED';
}

/** Native asset sentinel, re-exported so callers do not reach into intent.ts. */
export { ZERO_ADDRESS };
