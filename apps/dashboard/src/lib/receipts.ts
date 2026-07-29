import { explorerAddressUrl, explorerTxUrl, loadConfig } from '@assay/config';
import { verdictFromCode, type VerdictKind } from '@assay/core';
import { RECEIPT_REGISTRY_ABI } from '@assay/agent';
import { RpcPool } from '@assay/observer';
import type { Address, Hex } from 'viem';

/**
 * Read the receipt chain straight from the contract.
 *
 * No indexer and no database on purpose. The tamper-evidence the receipt chain
 * provides is worth nothing if checking it requires trusting a server, so the
 * explorer reads the same way any third party would — and through the same
 * independent RPC quorum the verifier uses.
 */
export interface ReceiptRow {
  receiptHash: Hex;
  intentHash: Hex;
  txHash: Hex;
  verdict: VerdictKind;
  reasonHash: Hex;
  prevHash: Hex;
  observedAt: number;
  verifier: Address;
  blockNumber: number;
  /** Absent when no transaction was ever reported (KeeperHub #1784). */
  explorerUrl?: string;
}

export interface ExplorerData {
  configured: boolean;
  chainId: number;
  receiptRegistry?: Address;
  registryUrl?: string;
  intentRegistry?: Address;
  intentRegistryUrl?: string;
  /**
   * A public RPC endpoint, so the `cast` commands shown in the UI are
   * copy-pasteable and reproduce a reading without anything from this repo.
   */
  rpcUrl?: string;
  total: number;
  rows: ReceiptRow[];
  summary: Record<VerdictKind, number>;
  /** How many providers currently agree on the chain tip. */
  providersAgreeing: number;
  providerCount: number;
  quorumRequired: number;
  error?: string;
}

const ZERO_HASH = `0x${'00'.repeat(32)}`;

const EMPTY_SUMMARY: Record<VerdictKind, number> = {
  VERIFIED: 0,
  DIVERGENT: 0,
  UNPROVEN: 0,
  NOT_EXECUTED: 0,
};

export async function loadReceipts(limit = 50): Promise<ExplorerData> {
  const config = loadConfig();
  const receiptRegistry = config.contracts.receiptRegistry;

  const base: ExplorerData = {
    configured: Boolean(receiptRegistry),
    chainId: config.chain.id,
    receiptRegistry,
    registryUrl: receiptRegistry
      ? explorerAddressUrl(config.chain.id, receiptRegistry)
      : undefined,
    intentRegistry: config.contracts.intentRegistry,
    intentRegistryUrl: config.contracts.intentRegistry
      ? explorerAddressUrl(config.chain.id, config.contracts.intentRegistry)
      : undefined,
    rpcUrl: config.observer.rpcUrls[0],
    total: 0,
    rows: [],
    summary: { ...EMPTY_SUMMARY },
    providersAgreeing: 0,
    providerCount: 0,
    quorumRequired: config.observer.quorum,
  };

  if (!receiptRegistry) {
    return { ...base, error: 'RECEIPT_REGISTRY is not configured' };
  }

  try {
    const pool = new RpcPool(config.chain.id, config.observer);
    const tip = await pool.getBlockNumber();

    const totalResult = await pool.readContract<bigint>({
      address: receiptRegistry,
      abi: RECEIPT_REGISTRY_ABI,
      functionName: 'totalReceipts',
      args: [],
    });
    const total = Number(totalResult.value ?? 0n);

    // Newest last onchain, so page from the end.
    const offset = Math.max(0, total - limit);
    const pageResult = await pool.readContract<readonly Hex[]>({
      address: receiptRegistry,
      abi: RECEIPT_REGISTRY_ABI,
      functionName: 'receiptsAt',
      args: [BigInt(offset), BigInt(limit)],
      // Fingerprint on the joined hashes so providers must agree on content.
    });

    const hashes = [...(pageResult.value ?? [])].reverse();

    const rows = await Promise.all(
      hashes.map(async (receiptHash) => {
        const result = await pool.readContract<RawReceipt>({
          address: receiptRegistry,
          abi: RECEIPT_REGISTRY_ABI,
          functionName: 'get',
          args: [receiptHash],
        });
        return result.value ? toRow(receiptHash, result.value, config.chain.id) : undefined;
      }),
    );

    const present = rows.filter((r): r is ReceiptRow => r !== undefined);

    const summary = { ...EMPTY_SUMMARY };
    for (const row of present) summary[row.verdict] += 1;

    return {
      ...base,
      total,
      rows: present,
      summary,
      providersAgreeing: tip.agreementCount,
      providerCount: pool.providerCount,
    };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

interface RawReceipt {
  intentHash: Hex;
  txHash: Hex;
  verdict: number;
  reasonHash: Hex;
  prevHash: Hex;
  observedAt: bigint;
  verifier: Address;
  blockNumber: bigint;
}

function toRow(receiptHash: Hex, raw: RawReceipt, chainId: number): ReceiptRow {
  const hasTx = raw.txHash !== ZERO_HASH;
  return {
    receiptHash,
    intentHash: raw.intentHash,
    txHash: raw.txHash,
    verdict: verdictFromCode(raw.verdict),
    reasonHash: raw.reasonHash,
    prevHash: raw.prevHash,
    observedAt: Number(raw.observedAt),
    verifier: raw.verifier,
    blockNumber: Number(raw.blockNumber),
    explorerUrl: hasTx ? explorerTxUrl(chainId, raw.txHash) : undefined,
  };
}

export function shorten(hash: string, size = 6): string {
  return `${hash.slice(0, 2 + size)}…${hash.slice(-4)}`;
}
