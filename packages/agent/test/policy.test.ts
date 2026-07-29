/**
 * Assertion sources used in this file:
 *   contract  — guard behaviour declared in src/policy.ts
 *   invariant — safety properties an unattended runner depends on
 */
import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '@assay/config';
import type { Intent } from '@assay/core';
import { PolicyGuard } from '../src/policy.js';

const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const TOPIC = `0x${'dd'.repeat(32)}` as const;

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    maxExecutionsPerDay: 10,
    maxValuePerTx: 5_000_000n,
    intentTtlSeconds: 900,
    maxAttempts: 3,
    killSwitch: false,
    tickIntervalMs: 60_000,
    ...overrides,
  };
}

function intent(overrides: Partial<Intent> = {}): Intent {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return {
    chainId: 11155111,
    target: TOKEN,
    selector: '0xa9059cbb',
    args: '0x',
    value: 0n,
    bounds: {
      balanceDeltas: [{ token: TOKEN, account: ACCOUNT, min: -1_000n, max: -1_000n }],
      requiredTopics: [TOPIC],
      maxGasUsed: 100_000n,
    },
    deadline: now + 600n,
    nonce: 1n,
    policyHash: `0x${'11'.repeat(32)}`,
    ...overrides,
  };
}

describe('PolicyGuard — pass', () => {
  /**
   * Asserted as a boundary pair: the same intent must pass under a permissive
   * config and produce a named violation under a restrictive one. Checking only
   * that it passes would also hold for a guard that never runs.
   */
  it('allows a well-formed intent, and the same intent trips a guard when limits tighten', () => {
    const subject = intent();

    // blindfold: contract — check() returns null when no guard is violated
    expect(new PolicyGuard(config()).check(subject, 1_000n)).toBeNull();

    // blindfold: contract — the identical intent must be rejected once a limit excludes it, proving the guard evaluated it
    expect(new PolicyGuard(config({ maxValuePerTx: 999n })).check(subject, 1_000n)?.code).toBe(
      'VALUE_CAP',
    );
  });
});

describe('PolicyGuard — kill switch', () => {
  it('blocks everything when set', () => {
    const violation = new PolicyGuard(config({ killSwitch: true })).check(intent(), 1n);

    // blindfold: invariant — the kill switch must stop the runner without a redeploy
    expect(violation?.code).toBe('KILL_SWITCH');
  });
});

describe('PolicyGuard — value cap', () => {
  it('blocks a transfer above the cap', () => {
    const violation = new PolicyGuard(config()).check(intent(), 5_000_001n);

    // blindfold: contract — maxValuePerTx bounds a single transfer
    expect(violation?.code).toBe('VALUE_CAP');
  });

  /** Pins the exact inclusive/exclusive boundary, in both directions. */
  it('permits exactly the cap and rejects one unit above it', () => {
    const guard = new PolicyGuard(config({ maxValuePerTx: 5_000_000n }));

    // blindfold: contract — the guard compares with >, so the cap itself is permitted
    expect(guard.check(intent(), 5_000_000n)).toBeNull();

    const violation = guard.check(intent(), 5_000_001n);
    // blindfold: contract — one base unit above the cap is a VALUE_CAP violation, fixing the boundary at 5_000_000
    expect(violation?.code).toBe('VALUE_CAP');
    // blindfold: contract — the detail renders the offending magnitude, per the guard's `would move ${magnitude}` template
    expect(violation?.detail).toContain('5000001');
  });

  /** An outflow expressed as a negative delta must not read as unbounded. */
  it('compares on magnitude, so a negative amount is still capped', () => {
    const violation = new PolicyGuard(config()).check(intent(), -5_000_001n);

    // blindfold: invariant — a sign flip must not bypass the value cap
    expect(violation?.code).toBe('VALUE_CAP');
  });
});

describe('PolicyGuard — daily execution cap', () => {
  it('blocks once the daily cap is reached', () => {
    const guard = new PolicyGuard(config({ maxExecutionsPerDay: 2 }));

    expect(guard.check(intent(), 1n)).toBeNull();
    guard.recordExecution();
    expect(guard.check(intent(), 1n)).toBeNull();
    guard.recordExecution();

    // blindfold: contract — the cap protects the KeeperHub execution quota
    expect(guard.check(intent(), 1n)?.code).toBe('DAILY_EXECUTION_CAP');
  });

  it('reports how many executions remain', () => {
    const guard = new PolicyGuard(config({ maxExecutionsPerDay: 3 }));
    guard.recordExecution();

    // blindfold: contract — remainingToday is cap minus executions recorded today
    expect(guard.remainingToday).toBe(2);
  });

  it('never reports a negative remainder', () => {
    const guard = new PolicyGuard(config({ maxExecutionsPerDay: 1 }));
    guard.recordExecution();
    guard.recordExecution();

    // blindfold: invariant — remainingToday is clamped at zero
    expect(guard.remainingToday).toBe(0);
  });
});

describe('PolicyGuard — deadlines', () => {
  it('blocks an intent whose deadline already passed', () => {
    const violation = new PolicyGuard(config()).check(intent({ deadline: 1n }), 1n);

    // blindfold: contract — a past deadline cannot be committed; IntentRegistry would revert anyway
    expect(violation?.code).toBe('DEADLINE_IN_PAST');
  });

  /**
   * A far-future deadline lets a stale intent execute long after the conditions
   * that justified it have changed.
   */
  it('blocks a deadline beyond twice the configured TTL', () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const violation = new PolicyGuard(config({ intentTtlSeconds: 900 })).check(
      intent({ deadline: now + 5_000n }),
      1n,
    );

    // blindfold: contract — the guard caps deadline at now + 2 * intentTtlSeconds
    expect(violation?.code).toBe('DEADLINE_TOO_FAR');
  });
});

describe('PolicyGuard — falsifiability', () => {
  /**
   * An intent that declares no observable effect cannot fail its own check, so
   * verifying it would prove nothing.
   */
  it('blocks an intent that declares no effect at all', () => {
    const violation = new PolicyGuard(config()).check(
      intent({ bounds: { balanceDeltas: [], requiredTopics: [], maxGasUsed: 0n } }),
      1n,
    );

    // blindfold: invariant — a non-falsifiable intent is refused rather than trivially VERIFIED
    expect(violation?.code).toBe('NO_DECLARED_EFFECT');
  });

  /**
   * Either kind of declared effect satisfies falsifiability on its own.
   * Asserted against the empty case so the test distinguishes "topics count"
   * from "the falsifiability guard is not running".
   */
  it('accepts a topic-only intent but rejects the same intent with the topic removed', () => {
    const guard = new PolicyGuard(config());

    // blindfold: contract — either balance bounds or required topics satisfy falsifiability
    expect(
      guard.check(
        intent({ bounds: { balanceDeltas: [], requiredTopics: [TOPIC], maxGasUsed: 0n } }),
        1n,
      ),
    ).toBeNull();

    const stripped = guard.check(
      intent({ bounds: { balanceDeltas: [], requiredTopics: [], maxGasUsed: 0n } }),
      1n,
    );
    // blindfold: contract — removing the only declared effect leaves nothing to falsify, so NO_DECLARED_EFFECT fires
    expect(stripped?.code).toBe('NO_DECLARED_EFFECT');
  });

  it('blocks bounds whose minimum exceeds their maximum', () => {
    const violation = new PolicyGuard(config()).check(
      intent({
        bounds: {
          balanceDeltas: [{ token: TOKEN, account: ACCOUNT, min: 10n, max: 5n }],
          requiredTopics: [],
          maxGasUsed: 0n,
        },
      }),
      1n,
    );

    // blindfold: invariant — an empty range can never be satisfied, so it is a config error not a divergence
    expect(violation?.code).toBe('INVALID_BOUNDS');
  });
});
