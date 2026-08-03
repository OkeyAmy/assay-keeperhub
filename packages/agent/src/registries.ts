import type { Abi, Address, Hex } from 'viem';
import type { ContractsConfig } from '@assay/config';
import type { Receipt } from '@assay/core';
import { DirectExecutor, executeWithRetry, type RetryOutcome } from '@assay/keeperhub';
import type { RpcPool } from '@assay/observer';

/**
 * Minimal ABIs for the two registries.
 *
 * Declared by hand rather than generated from build artifacts so that the
 * runtime does not depend on `forge build` having been run, and so KeeperHub's
 * explorer-based ABI auto-fetch is never relied on for freshly deployed,
 * unverified contracts.
 */
export const INTENT_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'commit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'intentHash', type: 'bytes32' },
      { name: 'chainId', type: 'uint256' },
      { name: 'deadline', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'isCommitted',
    stateMutability: 'view',
    inputs: [{ name: 'intentHash', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'isLive',
    stateMutability: 'view',
    inputs: [{ name: 'intentHash', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'committedAtBlock',
    stateMutability: 'view',
    inputs: [{ name: 'intentHash', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint64' }],
  },
] as const satisfies Abi;

export const RECEIPT_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'write',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'intentHash', type: 'bytes32' },
      { name: 'txHash', type: 'bytes32' },
      { name: 'verdict', type: 'uint8' },
      { name: 'reasonHash', type: 'bytes32' },
      { name: 'prevHash', type: 'bytes32' },
      { name: 'observedAt', type: 'uint64' },
    ],
    outputs: [{ name: 'receiptHash', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'head',
    stateMutability: 'view',
    inputs: [{ name: 'verifier', type: 'address' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'totalReceipts',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'summary',
    stateMutability: 'view',
    inputs: [{ name: 'verifier', type: 'address' }],
    outputs: [
      { name: 'verified', type: 'uint256' },
      { name: 'divergent', type: 'uint256' },
      { name: 'unproven', type: 'uint256' },
      { name: 'notExecuted', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'receiptsAt',
    stateMutability: 'view',
    inputs: [
      { name: 'offset', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
    outputs: [{ name: 'page', type: 'bytes32[]' }],
  },
  {
    type: 'function',
    name: 'get',
    stateMutability: 'view',
    inputs: [{ name: 'receiptHash', type: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'intentHash', type: 'bytes32' },
          { name: 'txHash', type: 'bytes32' },
          { name: 'verdict', type: 'uint8' },
          { name: 'reasonHash', type: 'bytes32' },
          { name: 'prevHash', type: 'bytes32' },
          { name: 'observedAt', type: 'uint64' },
          { name: 'verifier', type: 'address' },
          { name: 'blockNumber', type: 'uint64' },
        ],
      },
    ],
  },
] as const satisfies Abi;

/**
 * Writes to the registries, always through KeeperHub.
 *
 * There is no signer here and no viem wallet client — deliberately. Reads use
 * the independent RPC pool; writes go through the Direct Execution API. That
 * split is the project's central claim expressed as a class boundary.
 */
export class Registries {
  constructor(
    /**
     * Undefined when only the read path is configured. Reads never touch this,
     * so a caller holding nothing but RPC endpoints can still check
     * commitments and walk the receipt chain — requiring the executor's
     * credentials to *read* would make the independent path depend on the
     * party being verified.
     */
    private readonly directExecutor: DirectExecutor | undefined,
    private readonly pool: RpcPool,
    private readonly addresses: ContractsConfig,
    private readonly chainId: number,
  ) {}

  /** The write path. Every registry write goes through KeeperHub, or nowhere. */
  private get executor(): DirectExecutor {
    if (!this.directExecutor) {
      throw new Error('KH_API_KEY is not configured; registry writes go through KeeperHub');
    }
    return this.directExecutor;
  }

  private get intentRegistry(): Address {
    const address = this.addresses.intentRegistry;
    if (!address) throw new Error('INTENT_REGISTRY is not configured');
    return address;
  }

  private get receiptRegistry(): Address {
    const address = this.addresses.receiptRegistry;
    if (!address) throw new Error('RECEIPT_REGISTRY is not configured');
    return address;
  }

  /** Commit an intent hash onchain, before anything moves. */
  async commitIntent(intentHash: Hex, deadline: bigint): Promise<RetryOutcome> {
    return executeWithRetry(
      intentHash,
      this.chainId,
      (key, gasLimitMultiplier) =>
        this.executor.executeContractCall(
          {
            contractAddress: this.intentRegistry,
            chainId: this.chainId,
            functionName: 'commit',
            functionArgs: [intentHash, this.chainId, deadline],
            abi: INTENT_REGISTRY_ABI as unknown as Abi,
            gasLimitMultiplier,
          },
          key,
        ),
      { scope: 'commit', maxAttempts: 2 },
    );
  }

  /** Append a verification receipt to the chain. */
  async writeReceipt(receipt: Receipt, saltForKey: Hex): Promise<RetryOutcome> {
    return executeWithRetry(
      saltForKey,
      this.chainId,
      (key, gasLimitMultiplier) =>
        this.executor.executeContractCall(
          {
            contractAddress: this.receiptRegistry,
            chainId: this.chainId,
            functionName: 'write',
            functionArgs: [
              receipt.intentHash,
              receipt.txHash,
              receipt.verdict,
              receipt.reasonHash,
              receipt.prevHash,
              receipt.observedAt,
            ],
            abi: RECEIPT_REGISTRY_ABI as unknown as Abi,
            gasLimitMultiplier,
          },
          key,
        ),
      { scope: 'receipt', maxAttempts: 2 },
    );
  }

  /** Current head of a verifier's receipt chain. Read independently. */
  async getHead(verifier: Address): Promise<Hex> {
    const result = await this.pool.readContract<Hex>({
      address: this.receiptRegistry,
      abi: RECEIPT_REGISTRY_ABI,
      functionName: 'head',
      args: [verifier],
    });
    return result.value ?? (`0x${'00'.repeat(32)}` as Hex);
  }

  async isCommitted(intentHash: Hex): Promise<boolean> {
    const result = await this.pool.readContract<boolean>({
      address: this.intentRegistry,
      abi: INTENT_REGISTRY_ABI,
      functionName: 'isCommitted',
      args: [intentHash],
    });
    return result.value ?? false;
  }

  async totalReceipts(): Promise<bigint> {
    const result = await this.pool.readContract<bigint>({
      address: this.receiptRegistry,
      abi: RECEIPT_REGISTRY_ABI,
      functionName: 'totalReceipts',
      args: [],
    });
    return result.value ?? 0n;
  }

  async summary(verifier: Address): Promise<VerdictSummary> {
    const result = await this.pool.readContract<readonly [bigint, bigint, bigint, bigint]>({
      address: this.receiptRegistry,
      abi: RECEIPT_REGISTRY_ABI,
      functionName: 'summary',
      args: [verifier],
    });
    const [verified, divergent, unproven, notExecuted] = result.value ?? [0n, 0n, 0n, 0n];
    return { verified, divergent, unproven, notExecuted };
  }
}

export interface VerdictSummary {
  verified: bigint;
  divergent: bigint;
  unproven: bigint;
  notExecuted: bigint;
}
