import { decodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import type { Intent } from '@assay/core';
import { KeeperHubClient, KeeperHubError, type Response_ } from './client.js';

/**
 * Direct Execution API wrapper.
 *
 * Follows the "Safe First-Write Sequence" KeeperHub documents: simulate with
 * the same body you intend to broadcast, then broadcast that exact body under a
 * fresh idempotency key. Reusing the request shape between the two calls is
 * what makes the simulation meaningful, so the body is built once and passed to
 * both rather than reconstructed.
 */
export class DirectExecutor {
  constructor(private readonly client: KeeperHubClient) {}

  /**
   * Dry-run a contract call. Never signs, never broadcasts, never bills.
   *
   * A would-revert comes back as HTTP 400 rather than a 200 with a flag, so the
   * error is caught and translated instead of being allowed to abort the run —
   * "this would revert" is information, not a failure of the request.
   */
  async simulateContractCall(request: ContractCallRequest): Promise<SimulationOutcome> {
    try {
      const response = await this.client.post<SimulateResponse>(
        '/api/execute/contract-call',
        // `simulate` must be a strict boolean; strings and numbers are rejected
        // with a 400 specifically to stop a typo falling through to a broadcast.
        { ...toContractCallBody(request), simulate: true },
      );
      return {
        succeeded: response.data.success === true,
        wouldRevert: response.data.wouldRevert === true,
        gasEstimate: response.data.gasEstimate ? BigInt(response.data.gasEstimate) : undefined,
        from: response.data.from,
        returnValue: response.data.simulatedReturnValue,
      };
    } catch (error) {
      if (error instanceof KeeperHubError && error.httpStatus === 400) {
        const body = (error.body ?? {}) as SimulateResponse;
        if (body.wouldRevert === true) {
          return {
            succeeded: false,
            wouldRevert: true,
            revertReason: body.revertReason ?? error.message,
            from: body.from,
          };
        }
      }
      throw error;
    }
  }

  /** Broadcast a contract call. One attempt, one key — retries live in retry.ts. */
  async executeContractCall(
    request: ContractCallRequest,
    idempotencyKey: string,
  ): Promise<ExecuteAck> {
    const response = await this.client.post<ExecuteResponse>(
      '/api/execute/contract-call',
      toContractCallBody(request),
      { idempotencyKey },
    );
    return toAck(response, idempotencyKey);
  }

  async simulateTransfer(request: TransferRequest): Promise<SimulationOutcome> {
    try {
      const response = await this.client.post<SimulateResponse>('/api/execute/transfer', {
        ...toTransferBody(request),
        simulate: true,
      });
      return {
        succeeded: response.data.success === true,
        wouldRevert: response.data.wouldRevert === true,
        gasEstimate: response.data.gasEstimate ? BigInt(response.data.gasEstimate) : undefined,
        from: response.data.from,
      };
    } catch (error) {
      if (error instanceof KeeperHubError && error.httpStatus === 400) {
        const body = (error.body ?? {}) as SimulateResponse;
        if (body.wouldRevert === true) {
          return {
            succeeded: false,
            wouldRevert: true,
            revertReason: body.revertReason ?? error.message,
            from: body.from,
          };
        }
      }
      throw error;
    }
  }

  async executeTransfer(request: TransferRequest, idempotencyKey: string): Promise<ExecuteAck> {
    const response = await this.client.post<ExecuteResponse>(
      '/api/execute/transfer',
      toTransferBody(request),
      { idempotencyKey },
    );
    return toAck(response, idempotencyKey);
  }

  /** Chains the org can actually execute on, with testnet flags. */
  async listChains(): Promise<KeeperHubChain[]> {
    const response = await this.client.get<{ chains?: KeeperHubChain[] } | KeeperHubChain[]>(
      '/api/chains',
    );
    const data = response.data;
    return Array.isArray(data) ? data : (data.chains ?? []);
  }
}

export interface ContractCallRequest {
  contractAddress: Address;
  chainId: number;
  functionName: string;
  /** Decoded arguments. Serialised to the JSON-array string the API expects. */
  functionArgs?: unknown[];
  abi?: Abi;
  /** Native value in ether units, as a decimal string (their format, not wei). */
  value?: string;
  gasLimitMultiplier?: string;
}

export interface TransferRequest {
  chainId: number;
  recipientAddress: Address;
  /** Human-readable units, e.g. "0.1". */
  amount: string;
  /** Omit for the chain's native asset. */
  tokenAddress?: Address;
  gasLimitMultiplier?: string;
}

export interface SimulationOutcome {
  succeeded: boolean;
  wouldRevert: boolean;
  gasEstimate?: bigint;
  revertReason?: string;
  from?: Address;
  returnValue?: unknown;
}

export interface ExecuteAck {
  executionId: string;
  status: string;
  idempotencyKey: string;
  /**
   * True when KeeperHub served a stored response instead of executing.
   *
   * Their idempotency layer replays the original response for 24 hours. If that
   * stored response was a failure, every retry under the same key replays the
   * failure and nothing is ever resubmitted — KeeperHub issue #1840. Surfacing
   * this flag is what lets the reconciler's liveness check see the wedge.
   */
  replayed: boolean;
}

export interface KeeperHubChain {
  chainId?: number;
  id?: number;
  name?: string;
  isEnabled?: boolean;
  isTestnet?: boolean;
}

interface ExecuteResponse {
  executionId?: string;
  status?: string;
  result?: unknown;
  /** Present on read (view/pure) calls, which return inline rather than executing. */
  [key: string]: unknown;
}

interface SimulateResponse {
  success?: boolean;
  status?: string;
  from?: Address;
  to?: Address;
  value?: string;
  gasEstimate?: string;
  simulatedReturnValue?: unknown;
  wouldRevert?: boolean;
  revertReason?: string;
}

/**
 * Build the contract-call body.
 *
 * KeeperHub issue #1841: `chainId`, `functionArgs` and `gasLimitMultiplier` are
 * expected as strings. Passing a JS number for chainId or a real array for
 * functionArgs is accepted by the type system and rejected — or worse, silently
 * mishandled — by the API. Every one of those fields is stringified here so no
 * caller has to remember.
 */
function toContractCallBody(request: ContractCallRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contractAddress: request.contractAddress,
    chainId: String(request.chainId),
    functionName: request.functionName,
  };
  if (request.functionArgs !== undefined) {
    body.functionArgs = JSON.stringify(request.functionArgs.map(stringifyArg));
  }
  // ABI is auto-fetched from the block explorer when omitted, which fails for
  // freshly deployed unverified contracts — so pass it explicitly where known.
  if (request.abi !== undefined) body.abi = JSON.stringify(request.abi);
  if (request.value !== undefined) body.value = request.value;
  if (request.gasLimitMultiplier !== undefined) {
    body.gasLimitMultiplier = String(request.gasLimitMultiplier);
  }
  return body;
}

function toTransferBody(request: TransferRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    chainId: String(request.chainId),
    recipientAddress: request.recipientAddress,
    amount: request.amount,
  };
  if (request.tokenAddress !== undefined) body.tokenAddress = request.tokenAddress;
  if (request.gasLimitMultiplier !== undefined) {
    body.gasLimitMultiplier = String(request.gasLimitMultiplier);
  }
  return body;
}

/** bigints have no JSON representation; the API wants decimal strings anyway. */
function stringifyArg(arg: unknown): unknown {
  if (typeof arg === 'bigint') return arg.toString();
  if (Array.isArray(arg)) return arg.map(stringifyArg);
  return arg;
}

function toAck(response: Response_<ExecuteResponse>, idempotencyKey: string): ExecuteAck {
  const executionId = response.data.executionId;
  if (!executionId) {
    throw new KeeperHubError(
      'execute response carried no executionId; the call may have been a read, ' +
        'or the response shape has changed',
      response.status,
      { body: response.data },
    );
  }
  return {
    executionId,
    status: response.data.status ?? 'unknown',
    idempotencyKey,
    // A replay returns 200 with the stored response; a fresh broadcast returns 202.
    replayed: response.status === 200,
  };
}

/** Decode calldata against an ABI, for logging and receipt detail. */
export function describeCall(abi: Abi, data: Hex): string {
  try {
    const decoded = decodeFunctionData({ abi, data });
    return `${decoded.functionName}(${(decoded.args ?? []).map(String).join(', ')})`;
  } catch {
    return data.slice(0, 10);
  }
}

/** Build a contract-call request straight from a committed intent. */
export function contractCallForIntent(
  intent: Intent,
  functionName: string,
  functionArgs: unknown[],
  abi?: Abi,
  gasLimitMultiplier?: string,
): ContractCallRequest {
  return {
    contractAddress: intent.target,
    chainId: intent.chainId,
    functionName,
    functionArgs,
    abi,
    gasLimitMultiplier,
  };
}
