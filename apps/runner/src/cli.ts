#!/usr/bin/env node
import {
  enableDualStackFallback,
  explorerTxUrl,
  isTestnet,
  loadConfig,
  loadEnvFile,
} from '@assay/config';
import { hashIntent, verdictFromCode } from '@assay/core';
import { KeeperHubClient, DirectExecutor } from '@assay/keeperhub';
import { BlockscoutClient, RpcPool } from '@assay/observer';
import { wire, warnIfMainnet } from './wiring.js';
import { runLoop, runOnce } from './loop.js';

/**
 * Entry point.
 *
 * `doctor` exists because almost every failure in this system is a
 * configuration failure, and configuration failures are much cheaper to find
 * before a transaction than after one. It checks against the real services
 * rather than validating strings.
 */
async function main(): Promise<number> {
  // Commands run from the package directory; `.env` lives at the workspace root.
  loadEnvFile();
  enableDualStackFallback();
  const command = process.argv[2] ?? 'help';

  switch (command) {
    case 'doctor':
      return doctor();
    case 'once':
      return once();
    case 'run':
      return run();
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return 0;
    default:
      console.error(`unknown command: ${command}\n`);
      printHelp();
      return 1;
  }
}

function printHelp(): void {
  console.log(`
assay — proof of execution for onchain agents

  assay doctor    check configuration against the real KeeperHub and RPC endpoints
  assay once      run exactly one commit -> execute -> reconcile -> receipt cycle
  assay run       run continuously until stopped

Configuration is entirely environment-driven; see .env.example.
`);
}

/** Verify every external dependency actually answers, before spending gas. */
async function doctor(): Promise<number> {
  let failures = 0;
  const ok = (msg: string) => console.log(`  ok    ${msg}`);
  const bad = (msg: string) => {
    console.log(`  FAIL  ${msg}`);
    failures++;
  };
  const warn = (msg: string) => console.log(`  warn  ${msg}`);

  console.log('\nassay doctor\n');

  let config;
  try {
    config = loadConfig();
    ok(`config parsed (chain ${config.chain.id}, payments on ${config.chain.paymentChainId})`);
  } catch (error) {
    bad(`config: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  console.log(
    isTestnet(config.chain.id)
      ? `  ok    chain ${config.chain.id} is a testnet`
      : `  warn  chain ${config.chain.id} is MAINNET — transactions move real value`,
  );

  // --- independent read path ---
  if (config.observer.rpcUrls.length === 0) {
    bad('RPC_URLS is empty; the verifier would have no independent read path');
  } else if (config.observer.rpcUrls.length < 2) {
    warn(
      `only ${config.observer.rpcUrls.length} RPC endpoint configured; ` +
        'quorum of 2+ needs at least two independent providers',
    );
  } else {
    ok(`${config.observer.rpcUrls.length} independent RPC endpoints configured`);
  }

  if (config.observer.rpcUrls.length > 0) {
    try {
      const pool = new RpcPool(config.chain.id, config.observer);
      const tip = await pool.getBlockNumber();
      if (tip.agreementCount === 0) {
        bad(`no RPC provider responded: ${tip.errors.join('; ')}`);
      } else if (!tip.reachedQuorum) {
        warn(
          `only ${tip.agreementCount}/${tip.quorum} providers agreed on the chain tip ` +
            `(${tip.errors.join('; ')})`,
        );
      } else {
        ok(`RPC quorum reached at block ${tip.value}`);
      }
    } catch (error) {
      bad(`RPC pool: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (config.observer.blockscoutUrl) {
    const blockscout = new BlockscoutClient(config.observer.blockscoutUrl, config.observer.timeoutMs);
    if (await blockscout.isReachable()) {
      ok('Blockscout reachable');
    } else {
      warn(`Blockscout at ${config.observer.blockscoutUrl} did not respond; reads fall back to RPC`);
    }
  } else {
    warn('BLOCKSCOUT_URL not set; decoded reads unavailable, raw RPC only');
  }

  // --- KeeperHub ---
  if (!config.keeperhub.apiKey) {
    bad('KH_API_KEY not set; nothing can be executed');
  } else {
    try {
      const executor = new DirectExecutor(new KeeperHubClient(config.keeperhub));
      const chains = await executor.listChains();
      const target = chains.find((c) => (c.chainId ?? c.id) === config.chain.id);

      if (chains.length === 0) {
        warn('KeeperHub returned no chains; check the API key scope');
      } else if (!target) {
        bad(`KeeperHub does not list chain ${config.chain.id} for this org`);
      } else if (target.isEnabled === false) {
        bad(`KeeperHub lists chain ${config.chain.id} but it is not enabled`);
      } else {
        ok(
          `KeeperHub reachable; chain ${config.chain.id} enabled` +
            (target.isTestnet ? ' (testnet)' : ''),
        );
      }
    } catch (error) {
      bad(`KeeperHub: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // --- contracts ---
  if (!config.contracts.intentRegistry) bad('INTENT_REGISTRY not set');
  else ok(`IntentRegistry ${config.contracts.intentRegistry}`);

  if (!config.contracts.receiptRegistry) bad('RECEIPT_REGISTRY not set');
  else ok(`ReceiptRegistry ${config.contracts.receiptRegistry}`);

  if (config.agent.killSwitch) warn('KILL_SWITCH is set; the runner will refuse to execute');

  console.log(
    failures === 0
      ? '\nall required checks passed\n'
      : `\n${failures} required check(s) failed\n`,
  );
  return failures === 0 ? 0 : 1;
}

async function once(): Promise<number> {
  const wired = wire();
  warnIfMainnet(wired.config);
  const result = await runOnce(wired);
  return result === 'error' ? 1 : 0;
}

async function run(): Promise<number> {
  const wired = wire();
  warnIfMainnet(wired.config);
  await runLoop(wired);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });

export { hashIntent, verdictFromCode, explorerTxUrl };
