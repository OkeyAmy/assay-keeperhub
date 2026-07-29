import { explorerTxUrl } from '@assay/config';
import { isIdle, type CycleResult } from '@assay/agent';
import type { Wired } from './wiring.js';

/**
 * One full cycle, with human-readable reporting.
 *
 * Reports every outcome the same way, including the unflattering ones. A
 * DIVERGENT verdict is a successful run of the verifier, not a failure of it,
 * and the logs are written so that stays obvious.
 */
export async function runOnce(wired: Wired): Promise<CycleOutcome> {
  const planned = await wired.strategy.plan();

  if (isIdle(planned)) {
    console.log(`idle: ${planned.reason}`);
    return 'idle';
  }
  const plan = planned;

  console.log(`\nplan: ${plan.description}`);

  const result = await wired.cycle.run(plan);
  report(result, wired.config.chain.id);

  switch (result.status) {
    case 'blocked':
      return 'blocked';
    case 'commit-failed':
      return 'error';
    case 'not-executed':
      return 'not-executed';
    case 'complete':
      return result.verdict.kind === 'VERIFIED' ? 'verified' : 'flagged';
  }
}

/**
 * Run until interrupted.
 *
 * Errors inside a tick are logged and the loop continues: a single bad tick —
 * an RPC blip, a rate limit — is not a reason to stop verifying. SIGINT and
 * SIGTERM stop it cleanly so an in-flight cycle is not abandoned mid-write.
 */
export async function runLoop(wired: Wired): Promise<void> {
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log(`\n${signal} received; finishing the current cycle then stopping`);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  const interval = wired.config.agent.tickIntervalMs;
  console.log(
    `runner started: chain ${wired.config.chain.id}, tick ${interval}ms, ` +
      `${wired.policy.remainingToday} executions left today`,
  );

  while (!stopping) {
    try {
      await runOnce(wired);
    } catch (error) {
      console.error(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (stopping) break;
    await sleep(interval);
  }

  console.log('runner stopped');
}

function report(result: CycleResult, chainId: number): void {
  switch (result.status) {
    case 'blocked':
      console.log(`  blocked by policy: ${result.violation.code} — ${result.violation.detail}`);
      return;

    case 'commit-failed':
      console.log(`  intent commitment failed: ${result.error}`);
      return;

    case 'not-executed':
      console.log(`  not executed: ${result.verdict.reason}`);
      if (result.verdict.detail) console.log(`    ${result.verdict.detail}`);
      reportReceipt(result.receipt, chainId);
      return;

    case 'complete': {
      const { verdict } = result;
      console.log(`  verdict: ${verdict.kind} (${verdict.reason})`);
      if (verdict.detail) console.log(`    ${verdict.detail}`);

      for (const check of verdict.checks) {
        const mark = check.passed ? 'pass' : 'FAIL';
        console.log(`    ${mark}  ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
      }

      console.log(`    execution: ${result.executionId || '(none returned)'}`);
      if (result.executorError) console.log(`    executor error: ${result.executorError}`);
      for (const attemptError of result.attemptErrors) {
        console.log(`    attempt error: ${attemptError}`);
      }

      if (verdict.txHash) {
        const url = explorerTxUrl(chainId, verdict.txHash);
        console.log(`    tx: ${url ?? verdict.txHash}`);
      }
      reportReceipt(result.receipt, chainId);
      return;
    }
  }
}

function reportReceipt(receipt: { written: boolean; receiptHash: string; error?: string }, _chainId: number): void {
  if (receipt.written) {
    console.log(`    receipt: ${receipt.receiptHash}`);
  } else {
    console.log(`    receipt NOT written: ${receipt.error ?? 'unknown error'}`);
  }
}

export type CycleOutcome = 'idle' | 'blocked' | 'error' | 'not-executed' | 'verified' | 'flagged';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
