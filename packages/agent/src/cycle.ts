import type { Abi, Address, Hex } from 'viem';
import {
  buildReceipt,
  hashIntent,
  hashReceipt,
  reconcile,
  type AuditTrail,
  type Intent,
  type Receipt,
  type Verdict,
} from '@assay/core';
import {
  AuditCollector,
  DirectExecutor,
  executeWithRetry,
  KeeperHubError,
  type AttemptRecord,
} from '@assay/keeperhub';
import {
  observeAbsent,
  observeTransaction,
  type RpcPool,
  type SettleOptions,
} from '@assay/observer';
import { PolicyGuard, type PolicyViolation } from './policy.js';
import type { Registries } from './registries.js';

/**
 * One full Assay cycle.
 *
 * commit -> execute -> reconcile -> receipt, producing three KeeperHub-executed
 * transactions. The ordering is the product: the commitment must land before
 * the action, or there is nothing to hold the action to.
 *
 * The cycle never throws for an unhappy outcome. A divergence, a wedged retry
 * or an unreachable observer are all *results* — they get a verdict and a
 * receipt like anything else. It only throws when it cannot function at all.
 */
export class AssayCycle {
  constructor(
    private readonly deps: CycleDeps,
    private readonly policy: PolicyGuard,
    /**
     * Propagation window for a transaction this cycle just broadcast. Zero
     * disables waiting entirely; it never widens what counts as VERIFIED, only
     * how long absence must persist before it is believed.
     */
    private readonly settleTimeoutMs: number = 45_000,
  ) {}

  async run(plan: ActionPlan): Promise<CycleResult> {
    const intentHash = hashIntent(plan.intent);

    // 1. Policy. Checked before the commitment, because committing to something
    //    the policy forbids is itself a failure.
    const violation = this.policy.check(plan.intent, plan.valueMoved);
    if (violation) {
      return { status: 'blocked', intentHash, violation };
    }

    // 2. Simulate. Their documented safe-first-write sequence: the body that is
    //    simulated is the body that gets broadcast.
    const simulation = await this.simulate(plan);
    if (!simulation.succeeded) {
      const verdict = await this.verdictWithoutExecution(plan.intent, {
        executionId: '',
        status: 'error',
        attempts: [],
        simulation: {
          succeeded: false,
          gasEstimate: simulation.gasEstimate,
          revertReason: simulation.revertReason,
        },
      });
      const receipt = await this.recordReceipt(verdict);
      return { status: 'not-executed', intentHash, verdict, receipt };
    }

    // 3. Commit the intent onchain, before anything moves.
    const commit = await this.deps.registries.commitIntent(intentHash, plan.intent.deadline);
    if (!commit.ack) {
      return {
        status: 'commit-failed',
        intentHash,
        error: commit.terminalError?.message ?? 'intent commitment did not land',
      };
    }

    // 4. Execute the value-moving action.
    this.policy.recordExecution();
    const attempts = await this.execute(plan, intentHash, simulation);

    // 5. Reconcile what KeeperHub says against what the chain shows.
    //
    // The settle window exists because we have just broadcast: the executor
    // knows the hash before independent providers can see it. Without it the
    // agent reports UNPROVEN on its own healthy executions. A transaction still
    // unseen when the window closes remains UNPROVEN.
    const audit = await this.deps.audit.collect(attempts);
    const verdict = await this.verify(plan.intent, audit, {
      timeoutMs: this.settleTimeoutMs,
    });

    // 6. Write the receipt, whatever the verdict was.
    const receipt = await this.recordReceipt(verdict);

    return {
      status: 'complete',
      intentHash,
      verdict,
      receipt,
      commitExecutionId: commit.ack.executionId,
      executionId: audit.executionId,
      // Carried out so the runner can say *why* an execution produced no
      // evidence. Without it, a submission that failed outright and one that
      // succeeded silently both surface as the same bare TX_HASH_ABSENT.
      executorError: audit.error,
      attemptErrors: audit.attempts.map((a) => a.error).filter((e): e is string => Boolean(e)),
    };
  }

  /**
   * Reconcile an execution that already happened.
   *
   * Split out from `run` because this is what the marketplace workflow and the
   * MCP `assay_verify` tool call: verifying somebody else's execution, where
   * Assay was not the one that submitted it.
   */
  async verify(intent: Intent, audit: AuditTrail, settle: SettleOptions = {}): Promise<Verdict> {
    const observation = audit.txHash
      ? await observeTransaction(this.deps.pool, audit.txHash, intent, settle)
      : await observeAbsent(this.deps.pool);

    return reconcile(intent, audit, observation);
  }

  private async verdictWithoutExecution(intent: Intent, audit: AuditTrail): Promise<Verdict> {
    const observation = await observeAbsent(this.deps.pool);
    return reconcile(intent, audit, observation);
  }

  private async simulate(plan: ActionPlan) {
    return this.deps.executor.simulateContractCall({
      contractAddress: plan.intent.target,
      chainId: plan.intent.chainId,
      functionName: plan.functionName,
      functionArgs: plan.functionArgs,
      abi: plan.abi,
    });
  }

  private async execute(
    plan: ActionPlan,
    intentHash: Hex,
    simulation: { gasEstimate?: bigint },
  ): Promise<AttemptRecord[]> {
    const outcome = await executeWithRetry(
      intentHash,
      plan.intent.chainId,
      (key, gasLimitMultiplier) =>
        this.deps.executor.executeContractCall(
          {
            contractAddress: plan.intent.target,
            chainId: plan.intent.chainId,
            functionName: plan.functionName,
            functionArgs: plan.functionArgs,
            abi: plan.abi,
            gasLimitMultiplier,
          },
          key,
        ),
      { maxAttempts: this.deps.maxAttempts },
    );

    // Carry the simulation onto the first attempt so the reconciler can tell
    // "rejected before submission" apart from "submitted and failed".
    if (outcome.attempts.length > 0) {
      outcome.attempts[0].simulation = { succeeded: true, gasEstimate: simulation.gasEstimate };
    }

    return outcome.attempts;
  }

  /**
   * Append the verdict to the onchain receipt chain.
   *
   * The head is read from chain rather than cached, because a stale head makes
   * `ReceiptRegistry.write` revert with ChainBroken — which is the contract
   * working correctly, and not something to paper over with a retry.
   */
  private async recordReceipt(verdict: Verdict): Promise<ReceiptOutcome> {
    const prevHash = await this.deps.registries.getHead(this.deps.verifierAddress);
    const receipt = buildReceipt(verdict, prevHash);
    const receiptHash = hashReceipt(receipt);

    try {
      const outcome = await this.deps.registries.writeReceipt(receipt, receiptHash);
      return {
        receipt,
        receiptHash,
        executionId: outcome.ack?.executionId,
        written: Boolean(outcome.ack),
        error: outcome.terminalError?.message,
      };
    } catch (error) {
      return {
        receipt,
        receiptHash,
        written: false,
        error: error instanceof KeeperHubError ? error.message : String(error),
      };
    }
  }
}

export interface CycleDeps {
  executor: DirectExecutor;
  audit: AuditCollector;
  pool: RpcPool;
  registries: Registries;
  /** The org wallet KeeperHub executes from; owns the receipt chain. */
  verifierAddress: Address;
  maxAttempts: number;
}

/** What the strategy decided to do, plus everything needed to do it. */
export interface ActionPlan {
  intent: Intent;
  functionName: string;
  functionArgs: unknown[];
  abi?: Abi;
  /** Magnitude of value moved, for the policy value cap. */
  valueMoved: bigint;
  /** Human-readable summary, for logs and the explorer. */
  description: string;
}

export type CycleResult =
  | { status: 'blocked'; intentHash: Hex; violation: PolicyViolation }
  | { status: 'commit-failed'; intentHash: Hex; error: string }
  | { status: 'not-executed'; intentHash: Hex; verdict: Verdict; receipt: ReceiptOutcome }
  | {
      status: 'complete';
      intentHash: Hex;
      verdict: Verdict;
      receipt: ReceiptOutcome;
      commitExecutionId: string;
      executionId: string;
      /** Terminal error the executor reported for the run, if any. */
      executorError?: string;
      /** Per-attempt submission errors, in order. */
      attemptErrors: string[];
    };

export interface ReceiptOutcome {
  receipt: Receipt;
  receiptHash: Hex;
  executionId?: string;
  written: boolean;
  error?: string;
}
