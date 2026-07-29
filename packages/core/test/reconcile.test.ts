/**
 * Assertion sources used in this file:
 *   contract  — the VerdictReason -> VerdictKind mapping declared in src/verdict.ts
 *               (`kindForReason`) and the reason codes raised by src/reconcile.ts
 *   invariant — "UNPROVEN is never upgraded to VERIFIED", stated in src/verdict.ts
 *   issue     — KeeperHub tracker items this check exists to catch
 */
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { reconcile } from '../src/reconcile.js';
import { hashIntent } from '../src/intent.js';
import {
  AGENT,
  FIXED_NOW,
  makeAudit,
  makeIntent,
  makeObservation,
  TRANSFER_TOPIC,
  transferArgs,
  USDC,
  VAULT,
  TX_HASH,
} from './fixtures.js';

describe('reconcile — happy path', () => {
  it('returns VERIFIED when intent, audit trail and chain all agree', () => {
    const intent = makeIntent();
    const verdict = reconcile(intent, makeAudit(), makeObservation(intent), FIXED_NOW);

    expect(verdict.kind).toBe('VERIFIED'); // blindfold: contract — kindForReason('ALL_CHECKS_PASSED') === 'VERIFIED'
    expect(verdict.reason).toBe('ALL_CHECKS_PASSED'); // blindfold: contract — collapse() default when no check fails
    expect(verdict.checks.every((c) => c.passed)).toBe(true);
  });

  it('stamps the intent hash, tx hash and execution id onto the verdict', () => {
    const intent = makeIntent();
    const verdict = reconcile(intent, makeAudit(), makeObservation(intent), FIXED_NOW);

    expect(verdict.intentHash).toBe(hashIntent(intent));
    expect(verdict.txHash).toBe(TX_HASH);
    expect(verdict.executionId).toBe('exec_test_001'); // blindfold: contract — collapse() copies audit.executionId verbatim; value set by makeAudit fixture
    expect(verdict.observedAt).toBe(FIXED_NOW.nowMillis);
  });

  it('runs all four checks when a mined transaction is available', () => {
    const intent = makeIntent();
    const verdict = reconcile(intent, makeAudit(), makeObservation(intent), FIXED_NOW);

    // blindfold: contract — reconcile() pushes existence, then conformance+effect when haveMinedTx, then liveness
    expect(verdict.checks.map((c) => c.name)).toEqual([
      'existence',
      'conformance',
      'effect',
      'liveness',
    ]);
  });
});

describe('reconcile — existence', () => {
  it('is NOT_EXECUTED when the run was cancelled', () => {
    const intent = makeIntent();
    const audit = makeAudit({ status: 'cancelled', txHash: undefined, attempts: [] });
    const verdict = reconcile(intent, audit, makeObservation(intent), FIXED_NOW);

    expect(verdict.kind).toBe('NOT_EXECUTED'); // blindfold: contract — kindForReason('NO_EXECUTION_ATTEMPTED')
    expect(verdict.reason).toBe('NO_EXECUTION_ATTEMPTED'); // blindfold: contract — checkExistence raises this for status 'cancelled'
  });

  it('is NOT_EXECUTED when simulation rejected before submission', () => {
    const intent = makeIntent();
    const audit = makeAudit({
      status: 'error',
      txHash: undefined,
      attempts: [],
      simulation: { succeeded: false, revertReason: 'insufficient balance' },
    });
    const verdict = reconcile(intent, audit, makeObservation(intent), FIXED_NOW);

    expect(verdict.kind).toBe('NOT_EXECUTED'); // blindfold: contract — kindForReason('SIMULATION_REJECTED')
    expect(verdict.reason).toBe('SIMULATION_REJECTED'); // blindfold: contract — checkExistence raises this when simulation failed and no txHash exists
    expect(verdict.detail).toContain('insufficient balance'); // blindfold: contract — detail carries simulation.revertReason through
  });

  it('is NOT_EXECUTED with INTENT_EXPIRED when the deadline passed unsubmitted', () => {
    // Deadline 1_000 is far below FIXED_NOW.nowSeconds, so isExpired() holds.
    const intent = makeIntent({ deadline: 1_000n });
    const audit = makeAudit({ status: 'error', txHash: undefined, attempts: [], simulation: undefined });
    const verdict = reconcile(intent, audit, makeObservation(intent), FIXED_NOW);

    expect(verdict.kind).toBe('NOT_EXECUTED'); // blindfold: contract — kindForReason('INTENT_EXPIRED')
    expect(verdict.reason).toBe('INTENT_EXPIRED'); // blindfold: contract — checkExistence prefers expiry over generic no-attempt when deadline passed
  });

  it('is UNPROVEN — not VERIFIED — when the executor reports no txHash', () => {
    const intent = makeIntent();
    const audit = makeAudit({ txHash: undefined });
    const verdict = reconcile(intent, audit, makeObservation(intent), FIXED_NOW);

    expect(verdict.kind).toBe('UNPROVEN'); // blindfold: issue — KeeperHub #1784, sponsored/7702 executions return no txHash; absence of evidence must not read as success
    expect(verdict.reason).toBe('TX_HASH_ABSENT'); // blindfold: contract — checkExistence raises this when audit.txHash is undefined
  });

  it('is UNPROVEN when the claimed transaction is not visible onchain', () => {
    const intent = makeIntent();
    const observed = makeObservation(intent, { transaction: undefined });
    const verdict = reconcile(intent, makeAudit(), observed, FIXED_NOW);

    expect(verdict.kind).toBe('UNPROVEN'); // blindfold: contract — kindForReason('TX_NOT_FOUND_ONCHAIN')
    expect(verdict.reason).toBe('TX_NOT_FOUND_ONCHAIN'); // blindfold: contract — audit claims a hash the independent observer cannot see
  });

  it('is UNPROVEN when no observer could be reached', () => {
    const intent = makeIntent();
    const observed = makeObservation(intent, { available: false, agreementCount: 0 });
    const verdict = reconcile(intent, makeAudit(), observed, FIXED_NOW);

    expect(verdict.kind).toBe('UNPROVEN'); // blindfold: invariant — with no independent read path there is no basis for VERIFIED
    expect(verdict.reason).toBe('OBSERVER_UNAVAILABLE'); // blindfold: contract — checkExistence raises this when observed.available is false
  });

  it('is UNPROVEN when observers fail to reach quorum', () => {
    const intent = makeIntent();
    const observed = makeObservation(intent, { agreementCount: 1, quorumRequired: 2 });
    const verdict = reconcile(intent, makeAudit(), observed, FIXED_NOW);

    expect(verdict.kind).toBe('UNPROVEN'); // blindfold: invariant — a single unconfirmed provider is not independent corroboration
    expect(verdict.reason).toBe('OBSERVER_QUORUM_FAILED'); // blindfold: contract — agreementCount < quorumRequired
    expect(verdict.detail).toContain('1 of 2'); // blindfold: contract — detail template is `${agreementCount} of ${quorumRequired} required providers agreed`
  });

  it('is UNPROVEN while the transaction is visible but unmined', () => {
    const intent = makeIntent();
    const base = makeObservation(intent);
    const observed = makeObservation(intent, {
      transaction: { ...base.transaction!, status: undefined },
    });
    const verdict = reconcile(intent, makeAudit(), observed, FIXED_NOW);

    expect(verdict.kind).toBe('UNPROVEN'); // blindfold: contract — kindForReason('TX_NOT_MINED_YET')
    expect(verdict.reason).toBe('TX_NOT_MINED_YET'); // blindfold: contract — ObservedTransaction.status undefined means pending
  });
});

describe('reconcile — conformance', () => {
  it('is DIVERGENT when calldata does not match the commitment', () => {
    const intent = makeIntent();
    const base = makeObservation(intent);
    // Same selector, different recipient — the classic template-binding bug.
    const observed = makeObservation(intent, {
      transaction: {
        ...base.transaction!,
        input: `0xa9059cbb${transferArgs(AGENT, 10_000_000n).slice(2)}` as Hex,
      },
    });
    const verdict = reconcile(intent, makeAudit(), observed, FIXED_NOW);

    expect(verdict.kind).toBe('DIVERGENT'); // blindfold: contract — kindForReason('CALLDATA_MISMATCH')
    expect(verdict.reason).toBe('CALLDATA_MISMATCH'); // blindfold: contract — calldataMatchesIntent compares byte-for-byte
  });

  it('is DIVERGENT when the amount is off by a decimal', () => {
    const intent = makeIntent();
    const base = makeObservation(intent);
    const observed = makeObservation(intent, {
      transaction: {
        ...base.transaction!,
        input: `0xa9059cbb${transferArgs(VAULT, 100_000_000n).slice(2)}` as Hex,
      },
    });
    const verdict = reconcile(intent, makeAudit(), observed, FIXED_NOW);

    expect(verdict.kind).toBe('DIVERGENT'); // blindfold: contract — kindForReason('CALLDATA_MISMATCH')
    expect(verdict.reason).toBe('CALLDATA_MISMATCH'); // blindfold: contract — a 10x amount is an encoded-args difference, not a tolerated variance
  });

  it('is DIVERGENT when the transaction hit a different contract', () => {
    const intent = makeIntent();
    const base = makeObservation(intent);
    const observed = makeObservation(intent, {
      transaction: { ...base.transaction!, to: AGENT },
    });
    const verdict = reconcile(intent, makeAudit(), observed, FIXED_NOW);

    expect(verdict.kind).toBe('DIVERGENT'); // blindfold: contract — kindForReason('TARGET_MISMATCH')
    expect(verdict.reason).toBe('TARGET_MISMATCH'); // blindfold: contract — checkConformance compares tx.to against intent.target
  });

  it('is DIVERGENT when native value differs from the commitment', () => {
    const intent = makeIntent();
    const base = makeObservation(intent);
    const observed = makeObservation(intent, {
      transaction: { ...base.transaction!, value: 1n },
    });
    const verdict = reconcile(intent, makeAudit(), observed, FIXED_NOW);

    expect(verdict.kind).toBe('DIVERGENT'); // blindfold: contract — kindForReason('VALUE_MISMATCH')
    expect(verdict.reason).toBe('VALUE_MISMATCH'); // blindfold: contract — checkConformance requires exact equality on tx.value
  });

  it('is DIVERGENT when executed on the wrong chain', () => {
    const intent = makeIntent();
    const base = makeObservation(intent);
    const observed = makeObservation(intent, {
      transaction: { ...base.transaction!, chainId: 1 },
    });
    const verdict = reconcile(intent, makeAudit(), observed, FIXED_NOW);

    expect(verdict.kind).toBe('DIVERGENT'); // blindfold: contract — kindForReason('CHAIN_MISMATCH')
    expect(verdict.reason).toBe('CHAIN_MISMATCH'); // blindfold: contract — chain is checked before target so a cross-chain replay is named precisely
  });

  it('treats a contract-creation target as a mismatch rather than crashing', () => {
    const intent = makeIntent();
    const base = makeObservation(intent);
    const observed = makeObservation(intent, {
      transaction: { ...base.transaction!, to: null },
    });
    const verdict = reconcile(intent, makeAudit(), observed, FIXED_NOW);

    expect(verdict.kind).toBe('DIVERGENT'); // blindfold: contract — kindForReason('TARGET_MISMATCH')
    expect(verdict.reason).toBe('TARGET_MISMATCH'); // blindfold: contract — null `to` can never equal a committed target address
    expect(verdict.detail).toContain('contract creation'); // blindfold: contract — detail renders null `to` as 'contract creation'
  });
});

describe('reconcile — effect', () => {
  it('is DIVERGENT when the executor claims success but the chain reverted', () => {
    const intent = makeIntent();
    const base = makeObservation(intent);
    const observed = makeObservation(intent, {
      transaction: { ...base.transaction!, status: 'reverted' },
    });
    const verdict = reconcile(intent, makeAudit({ status: 'success' }), observed, FIXED_NOW);

    expect(verdict.kind).toBe('DIVERGENT'); // blindfold: contract — kindForReason('REVERTED_BUT_REPORTED_SUCCESS')
    expect(verdict.reason).toBe('REVERTED_BUT_REPORTED_SUCCESS'); // blindfold: contract — checkEffect compares audit.status against observed receipt status
  });

  it('is DIVERGENT when a balance moved outside the declared bounds', () => {
    const intent = makeIntent();
    // Fixture bounds pin the move at exactly 10 USDC; observe 60 instead.
    const observed = makeObservation(intent, {
      balanceDeltas: [
        { token: USDC, account: AGENT, before: 100_000_000n, after: 40_000_000n, delta: -60_000_000n },
        { token: USDC, account: VAULT, before: 0n, after: 60_000_000n, delta: 60_000_000n },
      ],
    });
    const verdict = reconcile(intent, makeAudit(), observed, FIXED_NOW);

    expect(verdict.kind).toBe('DIVERGENT'); // blindfold: contract — kindForReason('BALANCE_DELTA_OUT_OF_BOUNDS')
    expect(verdict.reason).toBe('BALANCE_DELTA_OUT_OF_BOUNDS'); // blindfold: contract — observed delta outside EffectBounds [min,max]
  });

  it('is DIVERGENT when a required event was not emitted', () => {
    const intent = makeIntent();
    const base = makeObservation(intent);
    const observed = makeObservation(intent, {
      transaction: { ...base.transaction!, logTopics: [], logCount: 1 },
    });
    const verdict = reconcile(intent, makeAudit(), observed, FIXED_NOW);

    expect(verdict.kind).toBe('DIVERGENT'); // blindfold: contract — kindForReason('REQUIRED_EVENT_MISSING')
    expect(verdict.reason).toBe('REQUIRED_EVENT_MISSING'); // blindfold: contract — intent.bounds.requiredTopics not present in observed logTopics
  });

  it('is DIVERGENT when gas exceeded the declared bound', () => {
    // Bound of 10_000 against the fixture's observed gasUsed of 52_000.
    const intent = makeIntent({
      bounds: { ...makeIntent().bounds, maxGasUsed: 10_000n },
    });
    const verdict = reconcile(intent, makeAudit(), makeObservation(intent), FIXED_NOW);

    expect(verdict.kind).toBe('DIVERGENT'); // blindfold: contract — kindForReason('GAS_EXCEEDED_BOUND')
    expect(verdict.reason).toBe('GAS_EXCEEDED_BOUND'); // blindfold: contract — tx.gasUsed > bounds.maxGasUsed
  });

  it('ignores the gas bound when it is set to zero', () => {
    const intent = makeIntent({ bounds: { ...makeIntent().bounds, maxGasUsed: 0n } });
    const verdict = reconcile(intent, makeAudit(), makeObservation(intent), FIXED_NOW);

    expect(verdict.kind).toBe('VERIFIED'); // blindfold: contract — EffectBounds.maxGasUsed documents 0n as "disabled"
  });

  it('is DIVERGENT when a "successful" transaction changed nothing', () => {
    const base = makeObservation(makeIntent());
    const observed = makeObservation(makeIntent(), {
      transaction: { ...base.transaction!, logTopics: [TRANSFER_TOPIC], logCount: 0 },
      balanceDeltas: [
        { token: USDC, account: AGENT, before: 100_000_000n, after: 100_000_000n, delta: 0n },
        { token: USDC, account: VAULT, before: 0n, after: 0n, delta: 0n },
      ],
    });
    // Declare a topic requirement but no balance bounds, so the no-op check is what fires.
    const intent = makeIntent({
      bounds: { balanceDeltas: [], requiredTopics: [TRANSFER_TOPIC], maxGasUsed: 0n },
    });
    const verdict = reconcile(intent, makeAudit(), observed, FIXED_NOW);

    expect(verdict.kind).toBe('DIVERGENT'); // blindfold: contract — kindForReason('NO_STATE_CHANGE_ON_SUCCESS')
    expect(verdict.reason).toBe('NO_STATE_CHANGE_ON_SUCCESS'); // blindfold: contract — declared effects with zero logs and zero deltas is a no-op
  });

  it('is UNPROVEN when balances could not be snapshotted', () => {
    const intent = makeIntent();
    const observed = makeObservation(intent, { balancesIncomplete: true });
    const verdict = reconcile(intent, makeAudit(), observed, FIXED_NOW);

    expect(verdict.kind).toBe('UNPROVEN'); // blindfold: invariant — missing measurement is not evidence of correctness
    expect(verdict.reason).toBe('BALANCE_SNAPSHOT_MISSING'); // blindfold: contract — checkEffect short-circuits on balancesIncomplete
  });

  it('is UNPROVEN when an expected account has no balance observation', () => {
    const intent = makeIntent();
    // Fixture intent bounds cover AGENT and VAULT; supply only AGENT.
    const observed = makeObservation(intent, {
      balanceDeltas: [
        { token: USDC, account: AGENT, before: 100_000_000n, after: 90_000_000n, delta: -10_000_000n },
      ],
    });
    const verdict = reconcile(intent, makeAudit(), observed, FIXED_NOW);

    expect(verdict.kind).toBe('UNPROVEN'); // blindfold: invariant — an unmeasured account cannot be asserted in-bounds
    expect(verdict.reason).toBe('BALANCE_SNAPSHOT_MISSING'); // blindfold: contract — findDelta returned undefined for a declared bound
  });

  it('accepts a delta anywhere inside an inclusive range', () => {
    // Fixture observes +10_000_000 for VAULT, inside [9_000_000, 11_000_000].
    const intent = makeIntent({
      bounds: {
        balanceDeltas: [{ token: USDC, account: VAULT, min: 9_000_000n, max: 11_000_000n }],
        requiredTopics: [],
        maxGasUsed: 0n,
      },
    });
    const verdict = reconcile(intent, makeAudit(), makeObservation(intent), FIXED_NOW);

    expect(verdict.kind).toBe('VERIFIED'); // blindfold: contract — BalanceDelta bounds are documented as inclusive
  });
});

describe('reconcile — liveness (KeeperHub issue #1840)', () => {
  it('is DIVERGENT when retries replayed a cached failure and never resubmitted', () => {
    const intent = makeIntent();
    const audit = makeAudit({
      status: 'error',
      txHash: undefined,
      attempts: [
        { index: 0, idempotencyKey: 'assay-static', status: 'error', error: 'nonce too low' },
        { index: 1, idempotencyKey: 'assay-static', status: 'error', replayed: true, error: 'nonce too low' },
        { index: 2, idempotencyKey: 'assay-static', status: 'error', replayed: true, error: 'nonce too low' },
      ],
    });
    const observed = makeObservation(intent, { transaction: undefined });
    const verdict = reconcile(intent, audit, observed, FIXED_NOW);

    expect(verdict.kind).toBe('DIVERGENT'); // blindfold: issue — KeeperHub #1840, a reused key replays a cached failure so retries never resubmit
    expect(verdict.reason).toBe('IDEMPOTENCY_WEDGE'); // blindfold: contract — checkLiveness raises this for failed replays with no landed attempt
    expect(verdict.detail).toContain('cannot recover'); // blindfold: contract — detail states retries under this key cannot recover
  });

  it('detects a wedge from repeated keys even without replay flags', () => {
    const intent = makeIntent();
    const audit = makeAudit({
      status: 'error',
      txHash: undefined,
      attempts: [
        { index: 0, idempotencyKey: 'assay-same', status: 'error' },
        { index: 1, idempotencyKey: 'assay-same', status: 'error' },
      ],
    });
    const observed = makeObservation(intent, { transaction: undefined });
    const verdict = reconcile(intent, audit, observed, FIXED_NOW);

    expect(verdict.kind).toBe('DIVERGENT'); // blindfold: issue — KeeperHub #1840 manifests even when the executor omits a replay flag
    expect(verdict.reason).toBe('IDEMPOTENCY_WEDGE'); // blindfold: contract — checkLiveness flags a single distinct key across all-failed attempts
  });

  it('does not flag a wedge when a later attempt with a fresh key landed', () => {
    const intent = makeIntent();
    const audit = makeAudit({
      attempts: [
        { index: 0, idempotencyKey: 'assay-a0', status: 'error', replayed: true, error: 'underpriced' },
        { index: 1, idempotencyKey: 'assay-a1', status: 'success', txHash: TX_HASH },
      ],
    });
    const verdict = reconcile(intent, audit, makeObservation(intent), FIXED_NOW);

    expect(verdict.kind).toBe('VERIFIED'); // blindfold: contract — checkLiveness exempts runs where some attempt succeeded; this is the correct-retry path
  });

  it('does not flag a wedge on a single attempt', () => {
    const intent = makeIntent();
    const verdict = reconcile(intent, makeAudit(), makeObservation(intent), FIXED_NOW);
    const liveness = verdict.checks.find((c) => c.name === 'liveness');

    expect(liveness?.passed).toBe(true);
  });
});

describe('reconcile — verdict precedence', () => {
  it('reports DIVERGENT over UNPROVEN when both are present', () => {
    const intent = makeIntent();
    const base = makeObservation(intent);
    // Calldata mismatch (DIVERGENT) alongside incomplete balances (UNPROVEN).
    const observed = makeObservation(intent, {
      transaction: {
        ...base.transaction!,
        input: `0xa9059cbb${transferArgs(AGENT, 1n).slice(2)}` as Hex,
      },
      balancesIncomplete: true,
    });
    const verdict = reconcile(intent, makeAudit(), observed, FIXED_NOW);

    expect(verdict.kind).toBe('DIVERGENT'); // blindfold: contract — SEVERITY ranks DIVERGENT above UNPROVEN, so proof of mismatch is not masked by missing data
  });

  it('never upgrades an UNPROVEN to VERIFIED', () => {
    const intent = makeIntent();
    const observed = makeObservation(intent, { available: false, agreementCount: 0 });
    const verdict = reconcile(intent, makeAudit(), observed, FIXED_NOW);

    expect(verdict.kind).not.toBe('VERIFIED'); // blindfold: invariant — stated in src/verdict.ts, nothing may upgrade UNPROVEN to VERIFIED
  });

  it('skips conformance and effect when there is no mined transaction to inspect', () => {
    const intent = makeIntent();
    const observed = makeObservation(intent, { transaction: undefined });
    const verdict = reconcile(intent, makeAudit(), observed, FIXED_NOW);

    // blindfold: contract — reconcile() gates conformance/effect on haveMinedTx to avoid confident-looking noise
    expect(verdict.checks.map((c) => c.name)).toEqual(['existence', 'liveness']);
  });
});

/**
 * Relayed (sponsored / EIP-7702) execution.
 *
 * Observed on Sepolia against KeeperHub: the top-level transaction is the
 * relayer's, so `to`, `from` and `input` all describe the wrapper rather than
 * the intent's target, and the intended call appears only as an inner call.
 * Comparing top-level fields marks every honest sponsored execution DIVERGENT.
 *
 * This is also the one path where calldata evidence is unavailable, so these
 * tests pin both sides: it must accept a genuine relayed transfer, and it must
 * not become a way to get VERIFIED without evidence.
 */
describe('reconcile — relayed execution', () => {
  const RELAYER = '0x5aF5194B4b0909eB978e3Cf1e25333852277f07D' as const;
  const RELAYER_EOA = '0xA17cb6adb58277E5b4A44B8c1ECB449BB6614E87' as const;

  /** A transfer that really happened, but reached USDC through a relayer. */
  function relayed(intent = makeIntent(), overrides = {}) {
    const base = makeObservation(intent);
    return {
      ...base,
      transaction: {
        ...base.transaction!,
        to: RELAYER,
        from: RELAYER_EOA,
        input: '0x9aefaff8' as Hex,
        logs: [{ address: USDC, topic: TRANSFER_TOPIC }],
        ...overrides,
      },
    };
  }

  it('is VERIFIED when the target was reached as an inner call and its effects match', () => {
    const intent = makeIntent();
    const verdict = reconcile(intent, makeAudit(), relayed(intent), FIXED_NOW);

    // blindfold: issue — KeeperHub sponsored execution puts the relayer in `to`;
    // the transfer is real and the declared bounds all hold, so this must not be DIVERGENT.
    expect(verdict.kind).toBe('VERIFIED');
    expect(verdict.reason).toBe('ALL_CHECKS_PASSED');
  });

  it('records that conformance came from events rather than calldata', () => {
    const intent = makeIntent();
    const verdict = reconcile(intent, makeAudit(), relayed(intent), FIXED_NOW);
    const conformance = verdict.checks.find((c) => c.name === 'conformance');

    // blindfold: invariant — a VERIFIED reached on weaker evidence must say so,
    // otherwise the receipt overstates what was actually checked.
    expect(conformance?.detail).toContain('not from calldata');
  });

  it('is DIVERGENT when the intended target never appears in the receipt', () => {
    const intent = makeIntent();
    const observation = relayed(intent, { logs: [{ address: VAULT, topic: TRANSFER_TOPIC }] });
    const verdict = reconcile(intent, makeAudit(), observation, FIXED_NOW);

    // blindfold: contract — kindForReason('TARGET_MISMATCH') === 'DIVERGENT'; without a
    // log from the target there is no evidence it was called at all.
    expect(verdict.kind).toBe('DIVERGENT');
    expect(verdict.reason).toBe('TARGET_MISMATCH');
  });

  it('is DIVERGENT when the required event came from a different contract', () => {
    const intent = makeIntent();
    const observation = relayed(intent, {
      logs: [
        { address: USDC, topic: '0xdeadbeef' as Hex },
        { address: VAULT, topic: TRANSFER_TOPIC },
      ],
    });
    const verdict = reconcile(intent, makeAudit(), observation, FIXED_NOW);

    // blindfold: invariant — attribution is the point. An unrelated contract emitting
    // the expected signature must not satisfy a check about the target's behaviour.
    expect(verdict.kind).toBe('DIVERGENT');
    expect(verdict.reason).toBe('REQUIRED_EVENT_MISSING');
  });

  it('is UNPROVEN — not VERIFIED — when the intent declared no checkable effect', () => {
    const intent = makeIntent({
      bounds: { balanceDeltas: [], requiredTopics: [], maxGasUsed: 100_000n },
    });
    const verdict = reconcile(intent, makeAudit(), relayed(intent), FIXED_NOW);

    // blindfold: invariant — "UNPROVEN is never upgraded to VERIFIED". Through a relayer
    // an intent with no declared effect is entirely uncheckable, so it cannot pass.
    expect(verdict.kind).toBe('UNPROVEN');
    expect(verdict.reason).toBe('RELAYED_EFFECT_UNDECLARED');
  });

  it('is UNPROVEN when native value is routed through a relayer', () => {
    const intent = makeIntent({ value: 1n });
    const verdict = reconcile(intent, makeAudit(), relayed(intent), FIXED_NOW);

    // blindfold: invariant — native value moved by an inner call cannot be attributed
    // without traces, so it is unproven rather than assumed correct.
    expect(verdict.kind).toBe('UNPROVEN');
    expect(verdict.reason).toBe('RELAYED_EFFECT_UNDECLARED');
  });

  it('still catches a bad amount when the transfer was relayed', () => {
    const intent = makeIntent();
    const observation = relayed(intent);
    observation.balanceDeltas = [
      { token: USDC, account: AGENT, before: 100_000_000n, after: 1n, delta: -99_999_999n },
    ];
    const verdict = reconcile(intent, makeAudit(), observation, FIXED_NOW);

    // blindfold: invariant — the relayed path must not weaken the effect check; the
    // declared balance bounds are what carry the verdict once calldata is unavailable.
    expect(verdict.kind).toBe('DIVERGENT');
    expect(verdict.reason).toBe('BALANCE_DELTA_OUT_OF_BOUNDS');
  });
});
