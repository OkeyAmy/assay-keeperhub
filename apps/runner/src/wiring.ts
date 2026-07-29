import type { Address } from 'viem';
import {
  assertCanExecute,
  assertCanObserveIndependently,
  isTestnet,
  loadConfig,
  type AssayConfig,
} from '@assay/config';
import { AssayCycle, PolicyGuard, Registries, TreasuryStrategy } from '@assay/agent';
import { AuditCollector, DirectExecutor, KeeperHubClient } from '@assay/keeperhub';
import { RpcPool } from '@assay/observer';

/**
 * Assemble the object graph once, so every entry point wires it identically.
 *
 * Deliberately explicit rather than a DI container: the read path and the write
 * path being visibly separate here is the point, and a container would hide it.
 */
export interface Wired {
  config: AssayConfig;
  pool: RpcPool;
  executor: DirectExecutor;
  audit: AuditCollector;
  registries: Registries;
  cycle: AssayCycle;
  policy: PolicyGuard;
  strategy: TreasuryStrategy;
  verifierAddress: Address;
}

export interface WireOptions {
  /** Skip the execution-side assertions, for read-only commands. */
  readOnly?: boolean;
  env?: Record<string, string | undefined>;
}

export function wire(options: WireOptions = {}): Wired {
  const config = loadConfig(options.env);

  assertCanObserveIndependently(config);
  if (!options.readOnly) assertCanExecute(config);

  const pool = new RpcPool(config.chain.id, config.observer);
  const client = new KeeperHubClient(config.keeperhub);
  const executor = new DirectExecutor(client);
  const audit = new AuditCollector(client);

  const verifierAddress = requireEnvAddress(options.env ?? process.env, 'ORG_WALLET_ADDRESS');

  const registries = new Registries(executor, pool, config.contracts, config.chain.id);
  const policy = new PolicyGuard(config.agent);

  const cycle = new AssayCycle(
    {
      executor,
      audit,
      pool,
      registries,
      verifierAddress,
      maxAttempts: config.agent.maxAttempts,
    },
    policy,
  );

  const env = options.env ?? process.env;
  const strategy = new TreasuryStrategy(
    {
      chainId: config.chain.id,
      token: requireEnvAddress(env, 'STRATEGY_TOKEN'),
      from: verifierAddress,
      to: requireEnvAddress(env, 'STRATEGY_RECIPIENT'),
      amountPerMove: requireEnvBigint(env, 'STRATEGY_AMOUNT'),
      minBalanceToAct: requireEnvBigint(env, 'STRATEGY_MIN_BALANCE'),
      maxGasUsed: BigInt(env.STRATEGY_MAX_GAS ?? '150000'),
    },
    pool,
    config.agent,
  );

  return {
    config,
    pool,
    executor,
    audit,
    registries,
    cycle,
    policy,
    strategy,
    verifierAddress,
  };
}

/**
 * Warn loudly when pointed at a mainnet.
 *
 * The default configuration is testnet. Moving off it should be a decision
 * somebody made on purpose, not something noticed afterwards in a block explorer.
 */
export function warnIfMainnet(config: AssayConfig): void {
  if (!isTestnet(config.chain.id)) {
    console.warn(
      `\n  !!  CHAIN_ID ${config.chain.id} is a MAINNET. Transactions will move real value.\n` +
        `      Value cap per transaction: ${config.agent.maxValuePerTx}\n` +
        `      Executions per day:        ${config.agent.maxExecutionsPerDay}\n`,
    );
  }
}

function requireEnvAddress(env: Record<string, string | undefined>, key: string): Address {
  const raw = env[key]?.trim();
  if (!raw) throw new Error(`${key} is required but not set`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new Error(`${key} must be a 20-byte hex address, got ${JSON.stringify(raw)}`);
  }
  return raw as Address;
}

function requireEnvBigint(env: Record<string, string | undefined>, key: string): bigint {
  const raw = env[key]?.trim();
  if (!raw) throw new Error(`${key} is required but not set`);
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`${key} must be an integer string, got ${JSON.stringify(raw)}`);
  }
}
