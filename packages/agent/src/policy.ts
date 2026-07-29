import type { AgentConfig } from '@assay/config';
import type { Intent } from '@assay/core';

/**
 * Guards that run before anything is committed or executed.
 *
 * These exist because the runner is designed to operate unattended for days.
 * Every limit here is a bound on how bad an unsupervised bug can get, so they
 * are checked before the commit rather than before the execution — a committed
 * intent is a public promise, and promising something the policy forbids is
 * itself a failure worth preventing.
 */
export class PolicyGuard {
  private executionsToday = 0;
  private dayStamp = currentDay();

  constructor(private readonly config: AgentConfig) {}

  /** Evaluate every guard. Returns the first violation, or null to proceed. */
  check(intent: Intent, valueMoved: bigint): PolicyViolation | null {
    if (this.config.killSwitch) {
      return { code: 'KILL_SWITCH', detail: 'KILL_SWITCH is set' };
    }

    this.rollDayIfNeeded();
    if (this.executionsToday >= this.config.maxExecutionsPerDay) {
      return {
        code: 'DAILY_EXECUTION_CAP',
        detail:
          `${this.executionsToday} executions already today, cap is ` +
          `${this.config.maxExecutionsPerDay}`,
      };
    }

    // Compared on absolute value so an outflow expressed as a negative delta is
    // not accidentally treated as unbounded.
    const magnitude = valueMoved < 0n ? -valueMoved : valueMoved;
    if (magnitude > this.config.maxValuePerTx) {
      return {
        code: 'VALUE_CAP',
        detail: `would move ${magnitude}, cap is ${this.config.maxValuePerTx}`,
      };
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    if (intent.deadline <= now) {
      return {
        code: 'DEADLINE_IN_PAST',
        detail: `deadline ${intent.deadline} is not in the future (now ${now})`,
      };
    }

    // A far-future deadline defeats the purpose of having one: it lets a stale
    // intent be executed long after the conditions that justified it changed.
    const maxDeadline = now + BigInt(this.config.intentTtlSeconds) * 2n;
    if (intent.deadline > maxDeadline) {
      return {
        code: 'DEADLINE_TOO_FAR',
        detail: `deadline ${intent.deadline} exceeds twice the configured TTL`,
      };
    }

    if (intent.bounds.balanceDeltas.length === 0 && intent.bounds.requiredTopics.length === 0) {
      return {
        code: 'NO_DECLARED_EFFECT',
        detail:
          'intent declares no balance bounds and no required events, so its ' +
          'outcome could not be falsified',
      };
    }

    for (const delta of intent.bounds.balanceDeltas) {
      if (delta.min > delta.max) {
        return {
          code: 'INVALID_BOUNDS',
          detail: `bound for ${delta.account} has min ${delta.min} above max ${delta.max}`,
        };
      }
    }

    return null;
  }

  /** Record that an execution was attempted, for the daily cap. */
  recordExecution(): void {
    this.rollDayIfNeeded();
    this.executionsToday += 1;
  }

  get remainingToday(): number {
    this.rollDayIfNeeded();
    return Math.max(0, this.config.maxExecutionsPerDay - this.executionsToday);
  }

  private rollDayIfNeeded(): void {
    const today = currentDay();
    if (today !== this.dayStamp) {
      this.dayStamp = today;
      this.executionsToday = 0;
    }
  }
}

export interface PolicyViolation {
  code:
    | 'KILL_SWITCH'
    | 'DAILY_EXECUTION_CAP'
    | 'VALUE_CAP'
    | 'DEADLINE_IN_PAST'
    | 'DEADLINE_TOO_FAR'
    | 'NO_DECLARED_EFFECT'
    | 'INVALID_BOUNDS';
  detail: string;
}

function currentDay(): string {
  return new Date().toISOString().slice(0, 10);
}
