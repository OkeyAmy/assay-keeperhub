import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { Intent } from '@assay/core';
import { observeTransaction } from '../src/observe.js';
import type { RpcPool } from '../src/rpc.js';

/**
 * The settle window is the one place in the observer where waiting longer can
 * change an answer, so it is also the one place where a bug quietly manufactures
 * a VERIFIED. These tests pin the boundary from both sides: it must tolerate a
 * transaction that is merely young, and it must not tolerate one that never
 * arrives.
 */

const TX_HASH = '0x287d206ef1504044502f46fb763e270fd7d8d2d8218e8a06c99adf298da6dedd' as Hex;

const INTENT = {
  chainId: 11155111,
  target: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  selector: '0xa9059cbb',
  args: '0x',
  value: 0n,
  bounds: { balanceDeltas: [], requiredTopics: [], maxGasUsed: 250_000n },
  deadline: 1_800_000_000n,
  nonce: 1n,
  policyHash: '0x00',
} as unknown as Intent;

interface PoolScript {
  /** Poll index at which the transaction becomes visible. Infinity = never. */
  visibleFrom: number;
  /** Simulate every provider throwing, so nothing is reachable at all. */
  unreachable?: boolean;
}

/**
 * A pool that counts how many times it was asked, so a test can assert the
 * *number of round trips* rather than just the final observation.
 */
function fakePool(script: PoolScript): { pool: RpcPool; calls: () => number } {
  let calls = 0;

  const absent = { agreementCount: script.unreachable ? 0 : 3, value: undefined };
  const tx = {
    agreementCount: 3,
    value: {
      hash: TX_HASH,
      from: '0x39D438c6C41168DB49DcAe73Fc0D8a6D5D48Aa57',
      to: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      input: '0xa9059cbb',
      value: 0n,
      blockNumber: 11_377_068n,
    },
  };
  const receipt = {
    agreementCount: 3,
    value: {
      blockNumber: 11_377_068n,
      status: 'success',
      gasUsed: 84_462n,
      logs: [],
    },
  };

  const pool = {
    quorum: 2,
    chainId: 11155111,
    getTransaction: async () => {
      calls += 1;
      return Math.floor((calls - 1) / 1) >= script.visibleFrom ? tx : absent;
    },
    getTransactionReceipt: async () =>
      calls > script.visibleFrom ? receipt : { ...absent },
    getNativeBalance: async () => ({ agreementCount: 0, value: undefined }),
    getTokenBalance: async () => ({ agreementCount: 0, value: undefined }),
  } as unknown as RpcPool;

  return { pool, calls: () => calls };
}

describe('observeTransaction settle window', () => {
  it('costs a single round trip when the transaction is already visible', async () => {
    const { pool, calls } = fakePool({ visibleFrom: 0 });

    const observation = await observeTransaction(pool, TX_HASH, INTENT, {
      timeoutMs: 45_000,
      intervalMs: 1,
    });

    expect(observation.transaction?.hash).toBe(TX_HASH);
    // blindfold: invariant — a settled chain must not pay for the window, or every
    // verification of a historical transaction becomes needlessly slow.
    expect(calls()).toBe(1);
  });

  it('sees a transaction that only propagates after the first read', async () => {
    const { pool, calls } = fakePool({ visibleFrom: 2 });

    const observation = await observeTransaction(pool, TX_HASH, INTENT, {
      timeoutMs: 45_000,
      intervalMs: 1,
    });

    // blindfold: invariant — this is the observed Sepolia behaviour the window
    // exists for: KeeperHub returns a hash before independent providers index it.
    expect(observation.transaction?.hash).toBe(TX_HASH);
    expect(calls()).toBeGreaterThan(1);
  });

  it('still reports the transaction as unseen once the window closes', async () => {
    const { pool } = fakePool({ visibleFrom: Number.POSITIVE_INFINITY });

    const observation = await observeTransaction(pool, TX_HASH, INTENT, {
      timeoutMs: 5,
      intervalMs: 1,
    });

    // blindfold: invariant — the window bounds how long absence must persist before
    // it is believed. It must never convert absence into evidence.
    expect(observation.available).toBe(true);
    expect(observation.transaction).toBeUndefined();
  });

  it('does not wait out the window when no provider is reachable', async () => {
    const { pool, calls } = fakePool({
      visibleFrom: Number.POSITIVE_INFINITY,
      unreachable: true,
    });

    const observation = await observeTransaction(pool, TX_HASH, INTENT, {
      timeoutMs: 45_000,
      intervalMs: 1,
    });

    // blindfold: invariant — unreachable providers are not a propagation delay, so
    // polling cannot help; reporting promptly is what distinguishes
    // OBSERVER_UNAVAILABLE from TX_NOT_FOUND_ONCHAIN.
    expect(observation.available).toBe(false);
    expect(calls()).toBe(1);
  });

  it('does not poll at all when no window is requested', async () => {
    const { pool, calls } = fakePool({ visibleFrom: Number.POSITIVE_INFINITY });

    await observeTransaction(pool, TX_HASH, INTENT);

    // blindfold: invariant — verifying somebody else's historical execution has
    // nothing to wait for, so the default must stay zero.
    expect(calls()).toBe(1);
  });
});
