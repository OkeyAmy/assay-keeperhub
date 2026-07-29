import { encodeAbiParameters, parseAbiParameters, type Address, type Hex } from 'viem';
import type { AuditTrail, ChainObservation, Intent } from '../src/index.js';
import { intentCalldata, ZERO_ADDRESS } from '../src/index.js';

export const AGENT: Address = '0x1111111111111111111111111111111111111111';
export const VAULT: Address = '0x2222222222222222222222222222222222222222';
export const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const REGISTRY: Address = '0x3333333333333333333333333333333333333333';

/** `transfer(address,uint256)` */
export const TRANSFER_SELECTOR: Hex = '0xa9059cbb';
/** `Transfer(address,address,uint256)` */
export const TRANSFER_TOPIC: Hex =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export const TX_HASH: Hex = `0x${'ab'.repeat(32)}`;

export function transferArgs(to: Address, amount: bigint): Hex {
  return encodeAbiParameters(parseAbiParameters('address, uint256'), [to, amount]);
}

/** A well-formed intent: move 10 USDC from the agent to the vault. */
export function makeIntent(overrides: Partial<Intent> = {}): Intent {
  const amount = 10_000_000n; // 10 USDC, 6 decimals
  return {
    chainId: 8453,
    target: USDC,
    selector: TRANSFER_SELECTOR,
    args: transferArgs(VAULT, amount),
    value: 0n,
    bounds: {
      balanceDeltas: [
        { token: USDC, account: AGENT, min: -amount, max: -amount },
        { token: USDC, account: VAULT, min: amount, max: amount },
      ],
      requiredTopics: [TRANSFER_TOPIC],
      maxGasUsed: 100_000n,
    },
    deadline: 2_000_000_000n,
    nonce: 1n,
    policyHash: `0x${'11'.repeat(32)}`,
    ...overrides,
  };
}

/** An audit trail describing a clean, single-attempt success. */
export function makeAudit(overrides: Partial<AuditTrail> = {}): AuditTrail {
  return {
    executionId: 'exec_test_001',
    status: 'success',
    txHash: TX_HASH,
    chainId: 8453,
    gasUsed: 52_000n,
    attempts: [
      {
        index: 0,
        idempotencyKey: 'assay-aaaa0000',
        status: 'success',
        txHash: TX_HASH,
        gasPriceWei: 1_000_000n,
      },
    ],
    simulation: { succeeded: true, gasEstimate: 55_000n },
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_002_000,
    ...overrides,
  };
}

/** An observation that agrees with `makeIntent` + `makeAudit`. */
export function makeObservation(
  intent: Intent = makeIntent(),
  overrides: Partial<ChainObservation> = {},
): ChainObservation {
  const amount = 10_000_000n;
  return {
    available: true,
    agreementCount: 2,
    quorumRequired: 2,
    transaction: {
      hash: TX_HASH,
      chainId: 8453,
      from: AGENT,
      to: intent.target,
      input: intentCalldata(intent),
      value: intent.value,
      blockNumber: 20_000_000n,
      status: 'success',
      gasUsed: 52_000n,
      logTopics: [TRANSFER_TOPIC],
      logCount: 1,
    },
    balanceDeltas: [
      { token: USDC, account: AGENT, before: 100_000_000n, after: 90_000_000n, delta: -amount },
      { token: USDC, account: VAULT, before: 0n, after: amount, delta: amount },
    ],
    observedAt: 1_700_000_003_000,
    ...overrides,
  };
}

export const FIXED_NOW = { nowSeconds: 1_700_000_000n, nowMillis: 1_700_000_003_000 };

export { ZERO_ADDRESS };
