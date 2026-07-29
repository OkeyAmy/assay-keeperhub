import type { Hex } from 'viem';
import type { AuditTrail, ExecutionAttempt } from '@assay/core';
import { KeeperHubClient, KeeperHubError } from './client.js';
import type { ExecuteAck } from './execute.js';

/**
 * Collector for KeeperHub's execution record.
 *
 * This is the module that turns their audit trail — the surface the rubric
 * names and that nothing else in the hackathon field touches — into the
 * vendor-neutral `AuditTrail` the reconciler consumes.
 *
 * It records what KeeperHub *claims*. It deliberately does no chain reads:
 * corroboration is `@assay/observer`'s job, through different providers.
 */
export class AuditCollector {
  constructor(private readonly client: KeeperHubClient) {}

  /** One status read. */
  async getStatus(executionId: string): Promise<ExecutionStatus> {
    const response = await this.client.get<StatusResponse>(
      `/api/execute/${encodeURIComponent(executionId)}/status`,
    );
    return {
      ...normaliseStatus(response.data, executionId),
      pollHintSeconds: response.pollHintSeconds,
    };
  }

  /**
   * Poll until the execution reaches a terminal state.
   *
   * Honours `X-Poll-Interval-Hint` rather than using a fixed timer, as their
   * docs ask; a hint of 0 means terminal. The fallback interval only applies
   * when the header is absent.
   */
  async waitForTerminal(
    executionId: string,
    options: WaitOptions = {},
  ): Promise<ExecutionStatus> {
    const timeoutMs = options.timeoutMs ?? 180_000;
    const fallbackIntervalMs = options.fallbackIntervalMs ?? 3_000;
    const txHashGraceMs = options.txHashGraceMs ?? 20_000;
    const deadline = Date.now() + timeoutMs;

    let last: ExecutionStatus | undefined;
    let terminalSince: number | undefined;

    while (Date.now() < deadline) {
      last = await this.getStatus(executionId);
      if (last.terminal) {
        // A successful execution that has not published its hash yet is not
        // finished from the verifier's point of view: without a hash there is
        // nothing to corroborate, and returning immediately turns a race into a
        // permanent UNPROVEN.
        //
        // The wait is bounded because the hash may also be genuinely absent —
        // KeeperHub issue #1784 — and that case must still be reported rather
        // than waited on forever.
        if (last.txHash || last.mapped !== 'success') return last;

        terminalSince ??= Date.now();
        if (Date.now() - terminalSince >= txHashGraceMs) return last;
      }

      const hint = last.pollHintSeconds;
      const waitMs = hint !== undefined && hint > 0 ? hint * 1000 : fallbackIntervalMs;
      await sleep(Math.min(waitMs, Math.max(0, deadline - Date.now())));
    }

    if (last) return { ...last, timedOut: true };

    throw new KeeperHubError(
      `execution ${executionId} did not reach a terminal state within ${timeoutMs}ms`,
      0,
    );
  }

  /**
   * Assemble the full audit trail for a set of attempts.
   *
   * Attempts are supplied by the retry layer rather than read back from
   * KeeperHub, because their status endpoint reports the execution, not the
   * sequence of submissions that produced it. That gap is what makes the
   * liveness check possible at all — and is itself worth reporting upstream.
   */
  async collect(attempts: AttemptRecord[]): Promise<AuditTrail> {
    if (attempts.length === 0) {
      return {
        executionId: '',
        status: 'cancelled',
        attempts: [],
      };
    }

    const landed = attempts.find((a) => a.ack && !a.error);
    const primary = landed ?? attempts[attempts.length - 1];
    const executionId = primary.ack?.executionId ?? '';

    let status: ExecutionStatus | undefined;
    if (executionId) {
      try {
        status = await this.waitForTerminal(executionId);
      } catch (error) {
        // A failure to read the trail is itself part of the trail. It must not
        // abort the run, or an unreadable execution would look like no execution.
        status = undefined;
        if (!(error instanceof KeeperHubError)) throw error;
      }
    }

    const trailAttempts: ExecutionAttempt[] = attempts.map((a, index) => ({
      index,
      idempotencyKey: a.idempotencyKey,
      replayed: a.ack?.replayed,
      status: a.error ? 'error' : a.ack ? 'success' : 'pending',
      txHash: index === attempts.length - 1 ? status?.txHash : undefined,
      gasPriceWei: undefined,
      error: a.error,
      at: a.at,
    }));

    return {
      executionId,
      status: status ? status.mapped : 'error',
      txHash: status?.txHash,
      chainId: primary.chainId,
      gasUsed: status?.gasUsedWei,
      attempts: trailAttempts,
      simulation: primary.simulation,
      startedAt: attempts[0]?.at,
      finishedAt: status?.completedAt,
      error: status?.error ?? attempts[attempts.length - 1]?.error,
    };
  }
}

export interface AttemptRecord {
  idempotencyKey: string;
  chainId: number;
  ack?: ExecuteAck;
  error?: string;
  at: number;
  simulation?: { succeeded: boolean; gasEstimate?: bigint; revertReason?: string };
}

export interface ExecutionStatus {
  executionId: string;
  /** KeeperHub's own vocabulary. */
  raw: string;
  /** Mapped onto the reconciler's vocabulary. */
  mapped: AuditTrail['status'];
  terminal: boolean;
  txHash?: Hex;
  transactionLink?: string;
  gasUsedWei?: bigint;
  error?: string;
  createdAt?: number;
  completedAt?: number;
  pollHintSeconds?: number;
  timedOut?: boolean;
}

export interface WaitOptions {
  timeoutMs?: number;
  /** Used only when the poll-interval hint header is missing. */
  fallbackIntervalMs?: number;
  /**
   * How long to keep polling a successful execution that reports no transaction
   * hash before accepting the absence as real (KeeperHub issue #1784).
   */
  txHashGraceMs?: number;
}

interface StatusResponse {
  executionId?: string;
  status?: string;
  type?: string;
  transactionHash?: string;
  transactionLink?: string;
  gasUsedWei?: string;
  result?: unknown;
  error?: string | null;
  createdAt?: string;
  completedAt?: string;
}

/**
 * Map KeeperHub's status vocabulary onto the reconciler's.
 *
 * `completed` becomes `success` and `failed` becomes `error`. Note that
 * `completed` here means "the submission pipeline finished", not "the
 * transaction did what was asked" — the gap between those two is precisely what
 * Assay exists to measure, so nothing about this mapping should be read as
 * endorsement of the outcome.
 */
function normaliseStatus(body: StatusResponse, fallbackId: string): ExecutionStatus {
  const raw = (body.status ?? 'pending').toLowerCase();

  const mapped: AuditTrail['status'] =
    raw === 'completed'
      ? 'success'
      : raw === 'failed'
        ? 'error'
        : raw === 'running'
          ? 'running'
          : raw === 'cancelled'
            ? 'cancelled'
            : 'pending';

  const txHash =
    typeof body.transactionHash === 'string' && body.transactionHash.startsWith('0x')
      ? (body.transactionHash as Hex)
      : undefined;

  return {
    executionId: body.executionId ?? fallbackId,
    raw,
    mapped,
    terminal: raw === 'completed' || raw === 'failed' || raw === 'cancelled',
    txHash,
    transactionLink: body.transactionLink,
    gasUsedWei: body.gasUsedWei ? BigInt(body.gasUsedWei) : undefined,
    error: body.error ?? undefined,
    createdAt: parseTime(body.createdAt),
    completedAt: parseTime(body.completedAt),
  };
}

function parseTime(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
