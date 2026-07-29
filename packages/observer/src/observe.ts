import type { Address, Hex } from 'viem';
import type {
  ChainObservation,
  Intent,
  ObservedBalanceDelta,
  ObservedLog,
} from '@assay/core';
import { ZERO_ADDRESS } from '@assay/core';
import { RpcPool } from './rpc.js';

export interface SettleOptions {
  /**
   * How long to keep asking independent providers for a transaction the
   * executor has already reported.
   *
   * The executor learns a hash at broadcast; independent providers only see it
   * once it has propagated and been mined. Reading immediately after execution
   * therefore reports absence for a transaction that is merely young, and every
   * cycle lands on UNPROVEN for a reason that has nothing to do with the
   * agent's behaviour.
   *
   * This is a bounded wait, not a retry-until-agreeable loop: the window is
   * declared up front and a transaction still unseen when it closes stays
   * UNPROVEN. Waiting longer is not permitted to turn into a better verdict.
   *
   * Defaults to 0 — callers verifying an arbitrary historical transaction have
   * nothing to wait for, so only the just-executed path opts in.
   */
  timeoutMs?: number;
  /** Gap between polls while inside the window. */
  intervalMs?: number;
}

/**
 * Build an independent picture of what a transaction actually did.
 *
 * Balance deltas are measured at `blockNumber - 1` and `blockNumber`, which
 * attributes the whole change to the block rather than to the transaction. For
 * an agent that is the only actor touching its own accounts this is exact; when
 * it is not, the bounds in the intent are what absorb the difference. The
 * alternative — replaying traces — needs an archive node and buys little here.
 *
 * Anything that cannot be measured is reported as unmeasured. This function
 * never guesses, because a guess here becomes a false VERIFIED downstream.
 */
export async function observeTransaction(
  pool: RpcPool,
  txHash: Hex,
  intent: Intent,
  settle: SettleOptions = {},
): Promise<ChainObservation> {
  const observedAt = Date.now();

  const [txResult, receiptResult] = await awaitPropagation(pool, txHash, settle);

  // Every provider errored — we know nothing, and must say so.
  if (txResult.agreementCount === 0 && receiptResult.agreementCount === 0) {
    return {
      available: false,
      agreementCount: 0,
      quorumRequired: pool.quorum,
      balanceDeltas: [],
      observedAt,
    };
  }

  const tx = txResult.value ?? null;
  const receipt = receiptResult.value ?? null;

  // Providers responded, but none of them can see this transaction.
  if (!tx) {
    return {
      available: true,
      agreementCount: txResult.agreementCount,
      quorumRequired: pool.quorum,
      balanceDeltas: [],
      observedAt,
    };
  }

  const blockNumber = receipt?.blockNumber ?? tx.blockNumber ?? null;
  const mined = blockNumber !== null && receipt !== null;

  const logTopics: Hex[] = mined
    ? receipt.logs.map((log) => log.topics[0]).filter((t): t is Hex => Boolean(t))
    : [];

  const logs: ObservedLog[] = mined
    ? receipt.logs
        .filter((log) => Boolean(log.topics[0]))
        .map((log) => ({ address: log.address, topic: log.topics[0] as Hex }))
    : [];

  const observation: ChainObservation = {
    available: true,
    // Corroboration is only as strong as the weaker of the two reads.
    agreementCount: Math.min(txResult.agreementCount, receiptResult.agreementCount || txResult.agreementCount),
    quorumRequired: pool.quorum,
    transaction: {
      hash: tx.hash,
      chainId: pool.chainId,
      from: tx.from,
      to: tx.to ?? null,
      input: tx.input,
      value: tx.value,
      blockNumber: blockNumber ?? 0n,
      status: mined ? (receipt.status === 'success' ? 'success' : 'reverted') : undefined,
      gasUsed: mined ? receipt.gasUsed : undefined,
      logTopics,
      logs,
      logCount: mined ? receipt.logs.length : 0,
    },
    balanceDeltas: [],
    observedAt,
  };

  if (!mined || blockNumber === null) {
    return observation;
  }

  const { deltas, incomplete } = await measureBalanceDeltas(pool, intent, blockNumber);
  observation.balanceDeltas = deltas;
  if (incomplete) observation.balancesIncomplete = true;

  return observation;
}

/**
 * Measure the balance movements the intent declared bounds for.
 *
 * Only the accounts named in the intent are read: measuring everything would
 * be unbounded work, and anything not declared is not something the agent
 * promised about.
 */
async function measureBalanceDeltas(
  pool: RpcPool,
  intent: Intent,
  blockNumber: bigint,
): Promise<{ deltas: ObservedBalanceDelta[]; incomplete: boolean }> {
  const targets = intent.bounds.balanceDeltas.map((d) => ({ token: d.token, account: d.account }));
  if (targets.length === 0) return { deltas: [], incomplete: false };

  const before = blockNumber - 1n;
  const deltas: ObservedBalanceDelta[] = [];
  let incomplete = false;

  const measurements = await Promise.all(
    targets.map(async ({ token, account }) => {
      const [beforeResult, afterResult] = await Promise.all([
        readBalance(pool, token, account, before),
        readBalance(pool, token, account, blockNumber),
      ]);
      return { token, account, beforeResult, afterResult };
    }),
  );

  for (const m of measurements) {
    // A balance that only one provider could produce is not corroborated, and
    // an uncorroborated number is worse than no number at all.
    if (
      !m.beforeResult.reachedQuorum ||
      !m.afterResult.reachedQuorum ||
      m.beforeResult.value === undefined ||
      m.afterResult.value === undefined
    ) {
      incomplete = true;
      continue;
    }
    deltas.push({
      token: m.token,
      account: m.account,
      before: m.beforeResult.value,
      after: m.afterResult.value,
      delta: m.afterResult.value - m.beforeResult.value,
    });
  }

  return { deltas, incomplete };
}

function readBalance(pool: RpcPool, token: Address, account: Address, blockNumber: bigint) {
  return token.toLowerCase() === ZERO_ADDRESS
    ? pool.getNativeBalance(account, blockNumber)
    : pool.getTokenBalance(token, account, blockNumber);
}

/**
 * Fetch the transaction and its receipt, re-polling while the settle window is
 * open and nothing has been seen yet.
 *
 * Returns as soon as any provider can see the transaction, so a settled chain
 * costs exactly one round trip and the window only matters when it is needed.
 */
async function awaitPropagation(
  pool: RpcPool,
  txHash: Hex,
  settle: SettleOptions,
): Promise<[Awaited<ReturnType<RpcPool['getTransaction']>>, Awaited<ReturnType<RpcPool['getTransactionReceipt']>>]> {
  const timeoutMs = settle.timeoutMs ?? 0;
  const intervalMs = settle.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const results = await Promise.all([
      pool.getTransaction(txHash),
      pool.getTransactionReceipt(txHash),
    ]);
    const [txResult, receiptResult] = results;

    // Seen by someone, and mined — nothing further to wait for.
    if (txResult.value && receiptResult.value) return results;

    // Providers are unreachable rather than merely behind. Waiting cannot fix
    // that, and reporting it promptly is the honest answer.
    if (txResult.agreementCount === 0 && receiptResult.agreementCount === 0) return results;

    if (Date.now() >= deadline) return results;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Observation for an execution that never produced a transaction hash.
 *
 * KeeperHub issue #1784 makes this a routine case rather than an edge one, so
 * it gets a named constructor instead of being improvised at each call site.
 */
export async function observeAbsent(pool: RpcPool): Promise<ChainObservation> {
  // Prove the pool is actually reachable, so "no transaction" is distinguishable
  // from "no observer". Those lead to different verdicts.
  const tip = await pool.getBlockNumber();
  return {
    available: tip.agreementCount > 0,
    agreementCount: tip.agreementCount,
    quorumRequired: pool.quorum,
    balanceDeltas: [],
    observedAt: Date.now(),
  };
}
