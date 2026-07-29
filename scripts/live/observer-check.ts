#!/usr/bin/env node
/**
 * Live proof that the independent read path works against a real chain.
 *
 * The gauntlet demonstrates the reconciler with constructed inputs, which is the
 * right way to exercise failure modes you cannot summon on demand. This does the
 * opposite: it talks to real public RPC endpoints, reads a real mined
 * transaction, and shows the quorum machinery agreeing on it.
 *
 * Needs no credentials — it uses public endpoints and only ever reads.
 *
 * Run: pnpm live:observer            (defaults to Ethereum Sepolia)
 *      RPC_URLS=... pnpm live:observer
 */
import type { Hex } from 'viem';
import { enableDualStackFallback, loadConfig, loadEnvFile } from '@assay/config';
import { observeTransaction, RpcPool } from '@assay/observer';
import type { Intent } from '@assay/core';

const DEFAULT_SEPOLIA_RPCS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://1rpc.io/sepolia',
  'https://sepolia.drpc.org',
].join(',');

/**
 * A placeholder intent.
 *
 * This script checks the *observation* path, not the verdict — an arbitrary
 * transaction was never committed to by this agent, so reconciling it would
 * correctly produce DIVERGENT and prove nothing about the reader.
 */
function probeIntent(chainId: number): Intent {
  return {
    chainId,
    target: '0x0000000000000000000000000000000000000000',
    selector: '0x00000000',
    args: '0x',
    value: 0n,
    bounds: { balanceDeltas: [], requiredTopics: [], maxGasUsed: 0n },
    deadline: 9_999_999_999n,
    nonce: 0n,
    policyHash: `0x${'00'.repeat(32)}`,
  };
}

async function main(): Promise<number> {
  // Honour the repo's .env when present; the defaults below keep this runnable
  // with no configuration at all.
  loadEnvFile();
  enableDualStackFallback();

  const config = loadConfig({
    ...process.env,
    CHAIN_ID: process.env.CHAIN_ID ?? '11155111',
    RPC_URLS: process.env.RPC_URLS ?? DEFAULT_SEPOLIA_RPCS,
    OBSERVER_QUORUM: process.env.OBSERVER_QUORUM ?? '2',
  });

  const pool = new RpcPool(config.chain.id, config.observer);
  console.log(`\nchain ${config.chain.id}`);
  console.log(`providers: ${pool.providerCount}, quorum: ${pool.quorum}\n`);

  const tip = await pool.getBlockNumber();
  console.log(`chain tip        ${tip.value}`);
  console.log(`agreeing         ${tip.agreementCount}/${pool.providerCount}`);
  console.log(`quorum reached   ${tip.reachedQuorum}`);
  for (const error of tip.errors) console.log(`provider error   ${error}`);

  if (tip.value === undefined) {
    console.log('\nno provider responded; cannot continue\n');
    return 1;
  }

  // Step back a few blocks so every provider has certainly indexed it.
  const target = tip.value - 5n;
  const block = await pool.readWithQuorum(
    `getBlock(${target})`,
    (client) => client.getBlock({ blockNumber: target }),
    (b) => String(b.hash),
  );

  const txHash = block.value?.transactions?.[0] as Hex | undefined;
  if (!txHash) {
    console.log(`\nblock ${target} carried no transactions; try again\n`);
    return 0;
  }

  console.log(`\nobserving ${txHash}`);
  console.log(`  from block ${block.value?.number}\n`);

  const observation = await observeTransaction(pool, txHash, probeIntent(config.chain.id));

  console.log(`available        ${observation.available}`);
  console.log(
    `agreeing         ${observation.agreementCount}/${observation.quorumRequired} required`,
  );
  console.log(`to               ${observation.transaction?.to}`);
  console.log(`status           ${observation.transaction?.status}`);
  console.log(`gas used         ${observation.transaction?.gasUsed}`);
  console.log(`logs             ${observation.transaction?.logCount}`);
  console.log(`calldata         ${observation.transaction?.input.slice(0, 10)}…\n`);

  const healthy =
    observation.available && observation.agreementCount >= observation.quorumRequired;
  console.log(
    healthy
      ? 'independent read path is live and corroborated\n'
      : 'independent read path did not reach quorum\n',
  );
  return healthy ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
