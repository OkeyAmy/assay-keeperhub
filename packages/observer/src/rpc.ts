import { createPublicClient, http, type Address, type Hex, type PublicClient } from 'viem';
import { getChain, type ObserverConfig } from '@assay/config';

/**
 * A pool of independent RPC providers.
 *
 * Independence is the whole point: the verdict is only worth something if the
 * data behind it came from somewhere other than the party being verified. This
 * pool is deliberately given no knowledge of KeeperHub, and
 * `scripts/check-boundaries.mjs` fails the build if that ever changes.
 */
export class RpcPool {
  private readonly clients: PublicClient[];
  readonly quorum: number;
  readonly chainId: number;

  constructor(chainId: number, config: ObserverConfig) {
    const chain = getChain(chainId);
    this.chainId = chainId;
    this.quorum = Math.max(1, config.quorum);

    const urls = config.rpcUrls.length > 0 ? config.rpcUrls : chain.rpcUrls.default.http.slice();

    this.clients = urls.map((url) =>
      createPublicClient({
        chain,
        transport: http(url, { timeout: config.timeoutMs, retryCount: 1 }),
      }),
    );

    if (this.clients.length === 0) {
      throw new Error(`no RPC endpoints configured for chain ${chainId}`);
    }
  }

  get providerCount(): number {
    return this.clients.length;
  }

  /**
   * Run a read against every provider and report how many agreed.
   *
   * Agreement is decided by a caller-supplied fingerprint rather than deep
   * equality, because responses carry provider-specific noise (block tags,
   * casing) that is not part of the fact being corroborated.
   *
   * Failures are counted as disagreement, never as absence of a result. A
   * provider being down must not be able to turn a DIVERGENT into a VERIFIED.
   */
  async readWithQuorum<T>(
    label: string,
    read: (client: PublicClient) => Promise<T>,
    fingerprint: (value: T) => string,
  ): Promise<QuorumResult<T>> {
    const settled = await Promise.allSettled(this.clients.map((client) => read(client)));

    const buckets = new Map<string, { value: T; count: number }>();
    const errors: string[] = [];

    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        errors.push(describeError(outcome.reason));
        continue;
      }
      const key = fingerprint(outcome.value);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.count += 1;
      } else {
        buckets.set(key, { value: outcome.value, count: 1 });
      }
    }

    let best: { value: T; count: number } | undefined;
    for (const bucket of buckets.values()) {
      if (!best || bucket.count > best.count) best = bucket;
    }

    if (!best) {
      return {
        label,
        value: undefined,
        agreementCount: 0,
        providerCount: this.clients.length,
        quorum: this.quorum,
        reachedQuorum: false,
        errors,
      };
    }

    return {
      label,
      value: best.value,
      agreementCount: best.count,
      providerCount: this.clients.length,
      quorum: this.quorum,
      reachedQuorum: best.count >= this.quorum,
      errors,
    };
  }

  /** Transaction as seen by the pool. Undefined when no provider can find it. */
  async getTransaction(hash: Hex) {
    return this.readWithQuorum(
      `getTransaction(${hash})`,
      async (client) => {
        try {
          return await client.getTransaction({ hash });
        } catch {
          return null;
        }
      },
      (tx) => (tx ? `${tx.hash}:${tx.blockNumber ?? 'pending'}` : 'absent'),
    );
  }

  async getTransactionReceipt(hash: Hex) {
    return this.readWithQuorum(
      `getTransactionReceipt(${hash})`,
      async (client) => {
        try {
          return await client.getTransactionReceipt({ hash });
        } catch {
          return null;
        }
      },
      (r) => (r ? `${r.transactionHash}:${r.status}:${r.gasUsed}` : 'absent'),
    );
  }

  async getBlockNumber() {
    return this.readWithQuorum(
      'getBlockNumber',
      (client) => client.getBlockNumber(),
      // Providers drift by a block or two at the tip; bucket to the nearest 5
      // so a healthy pool is not reported as disagreeing.
      (n) => String(n / 5n),
    );
  }

  /** Native balance at a specific block, so deltas can be measured exactly. */
  async getNativeBalance(account: Address, blockNumber: bigint) {
    return this.readWithQuorum(
      `getBalance(${account}@${blockNumber})`,
      (client) => client.getBalance({ address: account, blockNumber }),
      (v) => v.toString(),
    );
  }

  /** ERC-20 balance at a specific block. */
  async getTokenBalance(token: Address, account: Address, blockNumber: bigint) {
    return this.readWithQuorum(
      `balanceOf(${token},${account}@${blockNumber})`,
      async (client) =>
        client.readContract({
          address: token,
          abi: ERC20_BALANCE_ABI,
          functionName: 'balanceOf',
          args: [account],
          blockNumber,
        }) as Promise<bigint>,
      (v) => v.toString(),
    );
  }

  /** Read an arbitrary contract call with quorum, for strategy-side reads. */
  async readContract<T>(
    args: Parameters<PublicClient['readContract']>[0],
    fingerprint: (value: T) => string = (v) => String(v),
  ) {
    return this.readWithQuorum(
      `readContract(${String(args.address)}.${String(args.functionName)})`,
      (client) => client.readContract(args) as Promise<T>,
      fingerprint,
    );
  }
}

export interface QuorumResult<T> {
  label: string;
  /** Best-supported value. Undefined when every provider failed. */
  value: T | undefined;
  agreementCount: number;
  providerCount: number;
  quorum: number;
  reachedQuorum: boolean;
  /** One entry per provider that threw. */
  errors: string[];
}

export const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

function describeError(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}
