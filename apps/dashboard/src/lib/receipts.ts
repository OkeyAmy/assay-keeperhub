import { explorerAddressUrl, explorerTxUrl, loadConfig } from '@assay/config';
import { reasonFromHash, verdictFromCode, type VerdictKind, type VerdictReason } from '@assay/core';
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
  /**
   * The reason code the hash stands for. Undefined when no known reason hashes
   * to it — a receipt from a different or newer verifier — which is shown as
   * unknown rather than guessed.
   */
  reason?: VerdictReason;
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
  /**
   * The KeeperHub org wallet that executes and owns this receipt chain. Shown
   * because every receipt below was written by it through KeeperHub — the page
   * should name who executed, not just what the verdict was.
   */
  verifier?: Address;
  verifierUrl?: string;
  /** KeeperHub marketplace listing this deployment publishes. */
  marketplaceSlug?: string;
  total: number;
  rows: ReceiptRow[];
  /** 0-indexed, page 0 is the newest receipts. */
  page: number;
  pageSize: number;
  pageCount: number;
  summary: Record<VerdictKind, number>;
  /**
   * Who the tally covers. `verifier` when it came from the registry's own
   * per-verifier counters; `all-verifiers` when it was counted by walking
   * every receipt. Surfaced because the two answer different questions and the
   * cards should not imply the wrong one.
   */
  summaryScope: 'verifier' | 'all-verifiers';
  /**
   * Receipts on this page the RPC quorum could not read. Reported rather than
   * quietly omitted: a page that drops rows it failed to fetch is making the
   * same mistake this project exists to catch — treating absence of evidence as
   * nothing worth mentioning.
   */
  unreadable: number;
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

export async function loadReceipts(
  { page = 0, pageSize = 20 }: { page?: number; pageSize?: number } = {},
): Promise<ExplorerData> {
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
    verifier: config.contracts.verifier,
    verifierUrl: config.contracts.verifier
      ? explorerAddressUrl(config.chain.id, config.contracts.verifier)
      : undefined,
    marketplaceSlug: config.keeperhub.marketplaceSlug,
    total: 0,
    rows: [],
    page: 0,
    pageSize,
    pageCount: 1,
    summary: { ...EMPTY_SUMMARY },
    summaryScope: 'all-verifiers',
    unreadable: 0,
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

    // Page 0 is the newest `pageSize` receipts. Receipts are appended oldest
    // first onchain, so paging forward through pages walks backward through
    // the array — `end` is the exclusive upper bound of the slice for `page`.
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const clampedPage = Math.min(Math.max(0, page), pageCount - 1);
    const end = Math.max(0, total - clampedPage * pageSize);
    const offset = Math.max(0, end - pageSize);
    const limit = end - offset;

    // Only the visible page is fetched. `get` is one quorum read per receipt,
    // so pulling the whole registry to render twenty rows makes the page cost
    // grow with the chain's length — the thing pagination exists to stop.
    const pageResult = await pool.readContract<readonly Hex[]>({
      address: receiptRegistry,
      abi: RECEIPT_REGISTRY_ABI,
      functionName: 'receiptsAt',
      args: [BigInt(offset), BigInt(limit)],
    });

    // Newest last onchain; the page reads newest first.
    const hashes = [...(pageResult.value ?? [])].reverse();

    const present = await fetchRows(pool, receiptRegistry, hashes, config.chain.id);

    // The tally must describe the whole chain, not the current page, or it
    // would shift as you page and contradict `total`. The registry already
    // counts verdicts per verifier, so ask it rather than recounting: one call
    // instead of one per receipt, and the same number `cast call summary(...)`
    // returns, which is what the docs quote.
    const summary = await loadSummary(pool, receiptRegistry, config.contracts.verifier);

    return {
      ...base,
      total,
      rows: present,
      page: clampedPage,
      pageCount,
      summary: summary.counts,
      summaryScope: summary.scope,
      unreadable: hashes.length - present.length,
      providersAgreeing: tip.agreementCount,
      providerCount: pool.providerCount,
    };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * How many receipts to read at once.
 *
 * Each `get` is a quorum read, so it costs one request *per provider*. Firing a
 * whole page at once meant ~80 simultaneous requests at four providers, which
 * public endpoints answer with rate limits — and a receipt whose every provider
 * was throttled reads as unavailable, so rows disappeared from the page. Small
 * batches keep the burst under that ceiling.
 */
const READ_CONCURRENCY = 4;

/** Run `worker` over `items`, at most `limit` in flight. Order is not preserved. */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

/**
 * Read every receipt on a page, in bounded batches, retrying what did not land.
 *
 * A throttled provider is a transport failure, not evidence about the receipt,
 * so it gets one more attempt before the row is reported missing. This never
 * invents data: a receipt that stays unreadable is left out and counted, which
 * is what `unreadable` on the returned data reports.
 */
async function fetchRows(
  pool: RpcPool,
  receiptRegistry: Address,
  hashes: readonly Hex[],
  chainId: number,
): Promise<ReceiptRow[]> {
  const found = new Map<Hex, ReceiptRow>();
  let pending: Hex[] = [...hashes];

  for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
    const failed: Hex[] = [];

    await mapWithConcurrency(pending, READ_CONCURRENCY, async (receiptHash) => {
      const result = await pool.readContract<RawReceipt>({
        address: receiptRegistry,
        abi: RECEIPT_REGISTRY_ABI,
        functionName: 'get',
        args: [receiptHash],
      });
      if (result.value) found.set(receiptHash, toRow(receiptHash, result.value, chainId));
      else failed.push(receiptHash);
    });

    pending = failed;
  }

  // Rebuild in the order the caller asked for; the batching above does not
  // preserve it, and the page is a chain whose order carries meaning.
  return hashes.map((h) => found.get(h)).filter((r): r is ReceiptRow => r !== undefined);
}

/**
 * Verdict tally for the whole chain, not just the rendered page.
 *
 * Preferred path is `summary(verifier)`: the registry keeps these counters
 * itself, so this is one call whatever the chain's length, and it returns
 * exactly what `cast call ... summary(address)` returns — the number quoted in
 * the docs, reproducible by anyone without this page.
 *
 * Without a configured verifier there is no per-verifier counter to ask for, so
 * it falls back to walking every receipt. That is O(total) and slow, and the
 * caller is told which of the two it got rather than being left to assume.
 */
async function loadSummary(
  pool: RpcPool,
  receiptRegistry: Address,
  verifier: Address | undefined,
): Promise<{ counts: Record<VerdictKind, number>; scope: 'verifier' | 'all-verifiers' }> {
  if (verifier) {
    const result = await pool.readContract<readonly [bigint, bigint, bigint, bigint]>({
      address: receiptRegistry,
      abi: RECEIPT_REGISTRY_ABI,
      functionName: 'summary',
      args: [verifier],
    });
    if (result.value) {
      const [verified, divergent, unproven, notExecuted] = result.value;
      return {
        counts: {
          VERIFIED: Number(verified),
          DIVERGENT: Number(divergent),
          UNPROVEN: Number(unproven),
          NOT_EXECUTED: Number(notExecuted),
        },
        scope: 'verifier',
      };
    }
  }

  const allResult = await pool.readContract<readonly Hex[]>({
    address: receiptRegistry,
    abi: RECEIPT_REGISTRY_ABI,
    functionName: 'totalReceipts',
    args: [],
  });
  const totalCount = Number(allResult.value ?? 0n);

  const hashesResult = await pool.readContract<readonly Hex[]>({
    address: receiptRegistry,
    abi: RECEIPT_REGISTRY_ABI,
    functionName: 'receiptsAt',
    args: [0n, BigInt(totalCount)],
  });

  const counts = { ...EMPTY_SUMMARY };
  await mapWithConcurrency(hashesResult.value ?? [], READ_CONCURRENCY, async (receiptHash) => {
    const r = await pool.readContract<RawReceipt>({
      address: receiptRegistry,
      abi: RECEIPT_REGISTRY_ABI,
      functionName: 'get',
      args: [receiptHash],
    });
    if (r.value) counts[verdictFromCode(r.value.verdict)] += 1;
  });

  return { counts, scope: 'all-verifiers' };
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
    reason: reasonFromHash(raw.reasonHash),
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
