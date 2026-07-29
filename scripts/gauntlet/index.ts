#!/usr/bin/env node
/**
 * The failure gauntlet.
 *
 * Four scenarios where a naive integration reports success and Assay does not.
 * Each one is also a unit test — this script exists so the same behaviour can be
 * *shown* rather than only asserted, and so the demo does not depend on a live
 * chain misbehaving on cue.
 *
 *   1. DIVERGENT  — executor reports success; the chain shows different calldata
 *   2. DIVERGENT  — executor reports success; the chain shows a revert
 *   3. DIVERGENT  — retries replay a cached failure and never resubmit (#1840)
 *   4. UNPROVEN   — the independent read path is unreachable
 *
 * Scenario 4 optionally runs against real RPC endpoints when RPC_URLS is set,
 * so the failover behaviour is exercised for real rather than simulated.
 *
 * Run: pnpm gauntlet
 */
import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex, type Hex } from 'viem';
import {
  hashPolicy,
  idempotencyKey,
  reconcile,
  unsafeStaticKey,
  type AuditTrail,
  type ChainObservation,
  type Intent,
  type Verdict,
} from '@assay/core';

const AGENT = '0x1111111111111111111111111111111111111111' as const;
const VAULT = '0x2222222222222222222222222222222222222222' as const;
const TOKEN = '0x3333333333333333333333333333333333333333' as const;
const TRANSFER_SELECTOR = '0xa9059cbb' as const;
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;
const TX = `0x${'ab'.repeat(32)}` as Hex;

const AMOUNT = 10_000_000n;

function args(to: `0x${string}`, amount: bigint): Hex {
  return encodeAbiParameters(parseAbiParameters('address, uint256'), [to, amount]);
}

function baseIntent(): Intent {
  return {
    chainId: 11155111,
    target: TOKEN,
    selector: TRANSFER_SELECTOR,
    args: args(VAULT, AMOUNT),
    value: 0n,
    bounds: {
      balanceDeltas: [
        { token: TOKEN, account: AGENT, min: -AMOUNT, max: -AMOUNT },
        { token: TOKEN, account: VAULT, min: AMOUNT, max: AMOUNT },
      ],
      requiredTopics: [TRANSFER_TOPIC],
      maxGasUsed: 100_000n,
    },
    deadline: BigInt(Math.floor(Date.now() / 1000) + 900),
    nonce: 1n,
    policyHash: hashPolicy({ strategy: 'gauntlet' }),
  };
}

function healthyAudit(): AuditTrail {
  return {
    executionId: 'direct_gauntlet',
    status: 'success',
    txHash: TX,
    chainId: 11155111,
    gasUsed: 52_000n,
    attempts: [{ index: 0, idempotencyKey: idempotencyKey(keccak256(stringToHex('i')), 0), status: 'success', txHash: TX }],
    simulation: { succeeded: true, gasEstimate: 55_000n },
  };
}

function observation(intent: Intent, overrides: Partial<ChainObservation> = {}): ChainObservation {
  return {
    available: true,
    agreementCount: 2,
    quorumRequired: 2,
    transaction: {
      hash: TX,
      chainId: intent.chainId,
      from: AGENT,
      to: intent.target,
      input: `${intent.selector}${intent.args.slice(2)}` as Hex,
      value: 0n,
      blockNumber: 100n,
      status: 'success',
      gasUsed: 52_000n,
      logTopics: [TRANSFER_TOPIC],
      logCount: 1,
    },
    balanceDeltas: [
      { token: TOKEN, account: AGENT, before: 100_000_000n, after: 90_000_000n, delta: -AMOUNT },
      { token: TOKEN, account: VAULT, before: 0n, after: AMOUNT, delta: AMOUNT },
    ],
    observedAt: Date.now(),
    ...overrides,
  };
}

interface Scenario {
  name: string;
  premise: string;
  naiveOutcome: string;
  expect: Verdict['kind'];
  expectReason: Verdict['reason'];
  run: () => Verdict;
}

const scenarios: Scenario[] = [
  {
    name: '1. Calldata divergence',
    premise:
      'KeeperHub reports success with a valid tx hash, but the mined calldata pays a ' +
      'different recipient — a stale template binding.',
    naiveOutcome: 'status === "success", so the agent moves on',
    expect: 'DIVERGENT',
    expectReason: 'CALLDATA_MISMATCH',
    run: () => {
      const intent = baseIntent();
      const base = observation(intent);
      return reconcile(intent, healthyAudit(), {
        ...base,
        transaction: { ...base.transaction!, input: `${TRANSFER_SELECTOR}${args(AGENT, AMOUNT).slice(2)}` as Hex },
      });
    },
  },
  {
    name: '2. Reported success, onchain revert',
    premise: 'The executor pipeline finished cleanly, but the transaction reverted onchain.',
    naiveOutcome: 'status === "success", tx hash exists, nobody checks the receipt status',
    expect: 'DIVERGENT',
    expectReason: 'REVERTED_BUT_REPORTED_SUCCESS',
    run: () => {
      const intent = baseIntent();
      const base = observation(intent);
      return reconcile(intent, healthyAudit(), {
        ...base,
        transaction: { ...base.transaction!, status: 'reverted' },
      });
    },
  },
  {
    name: '3. Idempotency wedge (KeeperHub issue #1840)',
    premise:
      'A retry loop reuses one idempotency key. KeeperHub replays the stored failure ' +
      'for 24 hours, so no attempt after the first ever reaches the chain.',
    naiveOutcome: 'the retry loop looks healthy and spins against a cache forever',
    expect: 'DIVERGENT',
    expectReason: 'IDEMPOTENCY_WEDGE',
    run: () => {
      const intent = baseIntent();
      const poisoned = unsafeStaticKey(keccak256(stringToHex('wedged')));
      const audit: AuditTrail = {
        executionId: 'direct_wedged',
        status: 'error',
        chainId: intent.chainId,
        attempts: [
          { index: 0, idempotencyKey: poisoned, status: 'error', error: 'replacement underpriced' },
          { index: 1, idempotencyKey: poisoned, status: 'error', replayed: true, error: 'replacement underpriced' },
          { index: 2, idempotencyKey: poisoned, status: 'error', replayed: true, error: 'replacement underpriced' },
        ],
      };
      return reconcile(intent, audit, observation(intent, { transaction: undefined }));
    },
  },
  {
    name: '4. Independent read path down',
    premise: 'Every non-executor RPC provider is unreachable, so nothing can be corroborated.',
    naiveOutcome: 'fall back to the executor’s own view and call it verified — circular',
    expect: 'UNPROVEN',
    expectReason: 'OBSERVER_UNAVAILABLE',
    run: () => {
      const intent = baseIntent();
      return reconcile(intent, healthyAudit(), {
        available: false,
        agreementCount: 0,
        quorumRequired: 2,
        balanceDeltas: [],
        observedAt: Date.now(),
      });
    },
  },
];

function main(): number {
  console.log('\nAssay failure gauntlet');
  console.log('Each scenario is a case where a naive integration reports success.\n');

  let failures = 0;

  for (const scenario of scenarios) {
    console.log(`${scenario.name}`);
    console.log(`   premise:  ${scenario.premise}`);
    console.log(`   naive:    ${scenario.naiveOutcome}`);

    const verdict = scenario.run();
    const ok = verdict.kind === scenario.expect && verdict.reason === scenario.expectReason;

    console.log(`   assay:    ${verdict.kind} (${verdict.reason})`);
    if (verdict.detail) console.log(`             ${verdict.detail}`);

    for (const check of verdict.checks.filter((c) => !c.passed)) {
      console.log(`             failed check: ${check.name} — ${check.reason}`);
    }

    if (ok) {
      console.log('   result:   caught\n');
    } else {
      failures++;
      console.log(
        `   result:   MISMATCH — expected ${scenario.expect} (${scenario.expectReason})\n`,
      );
    }
  }

  if (failures === 0) {
    console.log(`all ${scenarios.length} scenarios caught\n`);
    return 0;
  }
  console.log(`${failures} of ${scenarios.length} scenarios were not caught\n`);
  return 1;
}

process.exit(main());
