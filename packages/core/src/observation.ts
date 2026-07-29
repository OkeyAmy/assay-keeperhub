import type { Address, Hex } from 'viem';

/**
 * What an executor claims happened.
 *
 * Deliberately vendor-neutral: `@assay/keeperhub` maps KeeperHub's executions
 * API onto this shape, and nothing in the reconciler knows KeeperHub exists.
 * Every field is optional-by-absence rather than optional-by-default because
 * a missing field is evidence in itself, not a gap to paper over.
 */
export interface AuditTrail {
  /** Executor-side identifier, for tracing back into their logs. */
  executionId: string;
  /** What the executor says the outcome was. */
  status: 'pending' | 'running' | 'success' | 'error' | 'cancelled';
  /** Absent on sponsored/7702 executions — see KeeperHub issue #1784. */
  txHash?: Hex;
  chainId?: number;
  /** Gas the executor reports consuming. */
  gasUsed?: bigint;
  /** Every submission attempt, in order. Drives the liveness check. */
  attempts: ExecutionAttempt[];
  /** Executor's pre-flight simulation, if it ran one. */
  simulation?: SimulationResult;
  startedAt?: number;
  finishedAt?: number;
  /** Executor-reported error, verbatim. */
  error?: string;
}

export interface ExecutionAttempt {
  index: number;
  /** The idempotency key used for this attempt. */
  idempotencyKey?: string;
  /** True when the executor served a cached response instead of submitting. */
  replayed?: boolean;
  status: 'success' | 'error' | 'pending';
  txHash?: Hex;
  gasPriceWei?: bigint;
  error?: string;
  at?: number;
}

export interface SimulationResult {
  succeeded: boolean;
  gasEstimate?: bigint;
  revertReason?: string;
}

/**
 * What we independently saw on the chain.
 *
 * Produced by `@assay/observer` through RPC endpoints that are not the
 * executor's. If this came from the executor, the entire exercise is circular
 * and the verdict is worthless.
 */
export interface ChainObservation {
  /** False when no observer could be reached. Forces UNPROVEN, never VERIFIED. */
  available: boolean;
  /** How many independent providers agreed. Below quorum forces UNPROVEN. */
  agreementCount: number;
  quorumRequired: number;
  /** Absent when the transaction is not on chain at all. */
  transaction?: ObservedTransaction;
  /** Balance movements measured across the transaction's block boundary. */
  balanceDeltas: ObservedBalanceDelta[];
  /** True when balances could not be snapshotted on both sides. */
  balancesIncomplete?: boolean;
  observedAt: number;
}

export interface ObservedTransaction {
  hash: Hex;
  chainId: number;
  from: Address;
  /** Null for contract creation. */
  to: Address | null;
  input: Hex;
  value: bigint;
  blockNumber: bigint;
  /** Undefined while still pending. */
  status?: 'success' | 'reverted';
  gasUsed?: bigint;
  /** topic0 of every log the receipt emitted. */
  logTopics: Hex[];
  /**
   * (emitter, topic0) for every log.
   *
   * Attribution matters because a relayed execution's top-level `to` is the
   * relayer, not the contract the intent named. Knowing *which* contract
   * emitted an event is what lets the reconciler tell "the intended target was
   * called as an inner call" from "something else entirely happened".
   *
   * Optional because observations also arrive from outside this codebase via
   * the MCP tool. Absent is treated as "no attribution available", which can
   * only ever make a verdict more conservative.
   */
  logs?: ObservedLog[];
  logCount: number;
}

export interface ObservedLog {
  address: Address;
  /** topic0 — the event signature hash. */
  topic: Hex;
}

export interface ObservedBalanceDelta {
  token: Address;
  account: Address;
  before: bigint;
  after: bigint;
  delta: bigint;
}
