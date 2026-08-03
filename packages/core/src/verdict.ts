import type { Hex } from 'viem';

/**
 * The four things the reconciler is allowed to conclude.
 *
 * UNPROVEN exists on purpose. A verifier that cannot say "I could not tell"
 * will eventually say VERIFIED when it means UNPROVEN, and at that point it is
 * worse than having no verifier at all. Nothing in this codebase may upgrade
 * an UNPROVEN to a VERIFIED.
 */
export type VerdictKind = 'VERIFIED' | 'DIVERGENT' | 'UNPROVEN' | 'NOT_EXECUTED';

/** Why the reconciler reached its conclusion. One code per distinguishable cause. */
export type VerdictReason =
  // VERIFIED
  | 'ALL_CHECKS_PASSED'
  // NOT_EXECUTED
  | 'NO_EXECUTION_ATTEMPTED'
  | 'SIMULATION_REJECTED'
  | 'INTENT_EXPIRED'
  // DIVERGENT
  | 'CALLDATA_MISMATCH'
  | 'TARGET_MISMATCH'
  | 'VALUE_MISMATCH'
  | 'CHAIN_MISMATCH'
  | 'SENDER_MISMATCH'
  | 'BALANCE_DELTA_OUT_OF_BOUNDS'
  | 'REQUIRED_EVENT_MISSING'
  | 'GAS_EXCEEDED_BOUND'
  | 'REVERTED_BUT_REPORTED_SUCCESS'
  | 'NO_STATE_CHANGE_ON_SUCCESS'
  | 'IDEMPOTENCY_WEDGE'
  // UNPROVEN
  | 'TX_HASH_ABSENT'
  | 'TX_NOT_FOUND_ONCHAIN'
  | 'TX_NOT_MINED_YET'
  | 'OBSERVER_UNAVAILABLE'
  | 'OBSERVER_QUORUM_FAILED'
  | 'AUDIT_TRAIL_INCOMPLETE'
  | 'BALANCE_SNAPSHOT_MISSING'
  | 'RELAYED_EFFECT_UNDECLARED';

/**
 * Every reason, as runtime data.
 *
 * `VerdictReason` is a union, so it does not survive compilation — but a
 * receipt stores only `keccak(reason)`, and turning that back into something a
 * reader can act on needs the candidate list at runtime. The guard below fails
 * the build if a reason is added to the union and not to this array, so the two
 * cannot drift apart silently.
 */
export const VERDICT_REASONS = [
  'ALL_CHECKS_PASSED',
  'NO_EXECUTION_ATTEMPTED',
  'SIMULATION_REJECTED',
  'INTENT_EXPIRED',
  'CALLDATA_MISMATCH',
  'TARGET_MISMATCH',
  'VALUE_MISMATCH',
  'CHAIN_MISMATCH',
  'SENDER_MISMATCH',
  'BALANCE_DELTA_OUT_OF_BOUNDS',
  'REQUIRED_EVENT_MISSING',
  'GAS_EXCEEDED_BOUND',
  'REVERTED_BUT_REPORTED_SUCCESS',
  'NO_STATE_CHANGE_ON_SUCCESS',
  'IDEMPOTENCY_WEDGE',
  'TX_HASH_ABSENT',
  'TX_NOT_FOUND_ONCHAIN',
  'TX_NOT_MINED_YET',
  'OBSERVER_UNAVAILABLE',
  'OBSERVER_QUORUM_FAILED',
  'AUDIT_TRAIL_INCOMPLETE',
  'BALANCE_SNAPSHOT_MISSING',
  'RELAYED_EFFECT_UNDECLARED',
] as const satisfies readonly VerdictReason[];

/** Compile-time proof that `VERDICT_REASONS` covers the whole union. */
type UncoveredReason = Exclude<VerdictReason, (typeof VERDICT_REASONS)[number]>;
const _everyReasonIsListed: UncoveredReason extends never ? true : never = true;
void _everyReasonIsListed;

export interface CheckResult {
  name: 'existence' | 'conformance' | 'effect' | 'liveness';
  passed: boolean;
  /** Set when the check did not pass, or could not be run. */
  reason?: VerdictReason;
  /** Human-readable context. Ends up in the receipts explorer, so keep it legible. */
  detail?: string;
}

export interface Verdict {
  kind: VerdictKind;
  reason: VerdictReason;
  /** Every check that ran, in order, including the ones that passed. */
  checks: CheckResult[];
  intentHash: Hex;
  /** Absent when KeeperHub never reported one — see KeeperHub issue #1784. */
  txHash?: Hex;
  /** KeeperHub's execution id, so a receipt can be traced back to their audit trail. */
  executionId?: string;
  /** Unix milliseconds at which the verdict was reached. */
  observedAt: number;
  detail?: string;
}

/**
 * Severity ordering, used to collapse per-check results into one verdict.
 *
 * DIVERGENT outranks UNPROVEN: if one check proves a mismatch, missing data
 * elsewhere does not soften the conclusion. NOT_EXECUTED outranks both, since
 * there is nothing to diverge from if the action never ran.
 */
const SEVERITY: Record<VerdictKind, number> = {
  VERIFIED: 0,
  UNPROVEN: 1,
  DIVERGENT: 2,
  NOT_EXECUTED: 3,
};

export function isWorse(a: VerdictKind, b: VerdictKind): boolean {
  return SEVERITY[a] > SEVERITY[b];
}

/** Which verdict kind a given reason implies. Single source of truth. */
export function kindForReason(reason: VerdictReason): VerdictKind {
  switch (reason) {
    case 'ALL_CHECKS_PASSED':
      return 'VERIFIED';

    case 'NO_EXECUTION_ATTEMPTED':
    case 'SIMULATION_REJECTED':
    case 'INTENT_EXPIRED':
      return 'NOT_EXECUTED';

    case 'CALLDATA_MISMATCH':
    case 'TARGET_MISMATCH':
    case 'VALUE_MISMATCH':
    case 'CHAIN_MISMATCH':
    case 'SENDER_MISMATCH':
    case 'BALANCE_DELTA_OUT_OF_BOUNDS':
    case 'REQUIRED_EVENT_MISSING':
    case 'GAS_EXCEEDED_BOUND':
    case 'REVERTED_BUT_REPORTED_SUCCESS':
    case 'NO_STATE_CHANGE_ON_SUCCESS':
    case 'IDEMPOTENCY_WEDGE':
      return 'DIVERGENT';

    case 'TX_HASH_ABSENT':
    case 'TX_NOT_FOUND_ONCHAIN':
    case 'TX_NOT_MINED_YET':
    case 'OBSERVER_UNAVAILABLE':
    case 'OBSERVER_QUORUM_FAILED':
    case 'AUDIT_TRAIL_INCOMPLETE':
    case 'BALANCE_SNAPSHOT_MISSING':
    case 'RELAYED_EFFECT_UNDECLARED':
      return 'UNPROVEN';
  }
}

/** Numeric encoding for the onchain receipt. Kept in sync with ReceiptRegistry.sol. */
export const VERDICT_CODE: Record<VerdictKind, number> = {
  VERIFIED: 1,
  DIVERGENT: 2,
  UNPROVEN: 3,
  NOT_EXECUTED: 4,
};

export function verdictFromCode(code: number): VerdictKind {
  const found = (Object.keys(VERDICT_CODE) as VerdictKind[]).find((k) => VERDICT_CODE[k] === code);
  if (!found) throw new Error(`unknown verdict code: ${code}`);
  return found;
}
