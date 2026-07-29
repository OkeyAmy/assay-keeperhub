import type { Address, Hex } from 'viem';

/**
 * Blockscout REST client, used as a second opinion alongside raw RPC.
 *
 * KeeperHub and Blockscout jointly argue that reading and executing are
 * different disciplines and should be different systems
 * (keeperhub.com/blog/011-detect-decide-execute-blockscout). This client is
 * that argument made concrete: decoded, cross-chain-normalised reads that do
 * not come from the party being verified.
 *
 * Every method degrades to `undefined` rather than throwing. Blockscout being
 * unavailable must weaken a verdict to UNPROVEN, never fail the run.
 */
export class BlockscoutClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = 10_000,
  ) {}

  private async get<T>(path: string): Promise<T | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return undefined;
      return (await response.json()) as T;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Decoded transaction view, including the resolved method name and args. */
  async getTransaction(hash: Hex): Promise<BlockscoutTransaction | undefined> {
    return this.get<BlockscoutTransaction>(`/api/v2/transactions/${hash}`);
  }

  /** Token transfers Blockscout attributes to this transaction. */
  async getTokenTransfers(hash: Hex): Promise<BlockscoutTokenTransfer[]> {
    const body = await this.get<{ items?: BlockscoutTokenTransfer[] }>(
      `/api/v2/transactions/${hash}/token-transfers`,
    );
    return body?.items ?? [];
  }

  async getLogs(hash: Hex): Promise<BlockscoutLog[]> {
    const body = await this.get<{ items?: BlockscoutLog[] }>(`/api/v2/transactions/${hash}/logs`);
    return body?.items ?? [];
  }

  /** Liveness probe, so callers can distinguish "no data" from "no service". */
  async isReachable(): Promise<boolean> {
    const stats = await this.get<unknown>('/api/v2/stats');
    return stats !== undefined;
  }
}

export interface BlockscoutTransaction {
  hash: Hex;
  status: 'ok' | 'error' | null;
  result?: string;
  block_number?: number;
  from?: { hash: Address };
  to?: { hash: Address } | null;
  value?: string;
  gas_used?: string;
  raw_input?: Hex;
  /** Present when Blockscout has a verified ABI for the target. */
  decoded_input?: {
    method_call: string;
    method_id: string;
    parameters: { name: string; type: string; value: unknown }[];
  } | null;
  revert_reason?: string | null;
}

export interface BlockscoutTokenTransfer {
  from: { hash: Address };
  to: { hash: Address };
  token: { address: Address; symbol?: string; decimals?: string };
  total: { value: string; decimals?: string };
}

export interface BlockscoutLog {
  address: { hash: Address };
  topics: (Hex | null)[];
  data: Hex;
  decoded?: { method_call?: string } | null;
}

/**
 * Human-readable description of what a transaction did.
 *
 * Used by the receipts explorer so a judge sees "transfer 10 USDC to 0x22…"
 * rather than a calldata blob. Purely presentational — no verdict depends on it.
 */
export function describeTransfer(transfer: BlockscoutTokenTransfer): string {
  const decimals = Number(transfer.total.decimals ?? transfer.token.decimals ?? '0');
  const raw = BigInt(transfer.total.value);
  const symbol = transfer.token.symbol ?? 'tokens';
  if (decimals === 0) return `${raw} ${symbol}`;
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = (raw % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''} ${symbol}`;
}
