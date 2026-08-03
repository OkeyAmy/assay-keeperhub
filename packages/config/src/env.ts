import type { Address } from 'viem';
import { canSignWithAgenticWallet, getChain, isTestnet } from './chains.js';

/**
 * The only place in the codebase that reads `process.env`.
 *
 * Everything downstream takes a resolved config object, so switching chains,
 * RPC providers or contract addresses is an environment change rather than a
 * code change — and so tests never depend on ambient machine state.
 */
export interface AssayConfig {
  keeperhub: KeeperHubConfig;
  chain: ChainConfig;
  contracts: ContractsConfig;
  agent: AgentConfig;
  observer: ObserverConfig;
}

export interface KeeperHubConfig {
  apiBase: string;
  mcpUrl: string;
  /** Org API key, `kh_`-prefixed. Absent in read-only/dev contexts. */
  apiKey?: string;
  /** Marketplace slug this deployment publishes under. */
  marketplaceSlug: string;
}

export interface ChainConfig {
  /** Chain the agent executes its value-moving action on. */
  id: number;
  /** Chain used to settle x402/MPP payments. May differ from `id`. */
  paymentChainId: number;
}

export interface ContractsConfig {
  intentRegistry?: Address;
  receiptRegistry?: Address;
  /**
   * The verifier whose receipt chain this deployment owns — the KeeperHub org
   * wallet that executes. Optional: reads work without it, but knowing it lets
   * a reader ask the registry for a verdict tally directly (`summary(address)`)
   * instead of walking every receipt to count them.
   */
  verifier?: Address;
}

export interface AgentConfig {
  /** Hard ceiling on executions per day, to protect the KeeperHub quota. */
  maxExecutionsPerDay: number;
  /** Largest single transfer the agent may attempt, in the token's base units. */
  maxValuePerTx: bigint;
  /** Seconds an intent stays valid after being committed. */
  intentTtlSeconds: number;
  /** Retry attempts before the agent gives up on an intent. */
  maxAttempts: number;
  killSwitch: boolean;
  /** Poll interval for the runner loop, in milliseconds. */
  tickIntervalMs: number;
}

/**
 * The independent read path.
 *
 * This is the half of the system that makes a verdict worth anything, so it
 * must never be sourced from the party being verified.
 */
export interface ObserverConfig {
  /** Independent RPC endpoints. Must not point at the executor's infrastructure. */
  rpcUrls: string[];
  /** How many providers must agree before a reading counts as corroborated. */
  quorum: number;
  /** Blockscout REST base for the target chain, if one is configured. */
  blockscoutUrl?: string;
  /** Per-request timeout, milliseconds. */
  timeoutMs: number;
}

class ConfigError extends Error {
  constructor(message: string) {
    super(`config: ${message}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string, fallback?: string): string {
  const raw = env[key]?.trim();
  if (raw) return raw;
  if (fallback !== undefined) return fallback;
  throw new ConfigError(`${key} is required but not set`);
}

function optional(env: Env, key: string): string | undefined {
  const raw = env[key]?.trim();
  return raw ? raw : undefined;
}

function int(env: Env, key: string, fallback: number): number {
  const raw = optional(env, key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new ConfigError(`${key} must be an integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function big(env: Env, key: string, fallback: bigint): bigint {
  const raw = optional(env, key);
  if (raw === undefined) return fallback;
  try {
    return BigInt(raw);
  } catch {
    throw new ConfigError(`${key} must be an integer string, got ${JSON.stringify(raw)}`);
  }
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = optional(env, key)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${key} must be a boolean, got ${JSON.stringify(raw)}`);
}

function list(env: Env, key: string): string[] {
  const raw = optional(env, key);
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function address(env: Env, key: string): Address | undefined {
  const raw = optional(env, key);
  if (!raw) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new ConfigError(`${key} must be a 20-byte hex address, got ${JSON.stringify(raw)}`);
  }
  return raw as Address;
}

/**
 * Build the config from an environment.
 *
 * Defaults are chosen so that a fresh checkout runs against Sepolia with
 * conservative guards, and nothing that could move real value is implicit.
 */
export function loadConfig(env: Env = process.env): AssayConfig {
  const chainId = int(env, 'CHAIN_ID', 11155111);
  // Ensure the chain is one we have a definition for, and fail loudly if not.
  getChain(chainId);

  const paymentChainId = int(env, 'PAYMENT_CHAIN_ID', 42431);
  getChain(paymentChainId);

  const rpcUrls = list(env, 'RPC_URLS');
  const quorum = int(env, 'OBSERVER_QUORUM', Math.min(2, Math.max(1, rpcUrls.length || 1)));

  if (quorum > rpcUrls.length && rpcUrls.length > 0) {
    throw new ConfigError(
      `OBSERVER_QUORUM (${quorum}) exceeds the number of configured RPC_URLS (${rpcUrls.length})`,
    );
  }

  return {
    keeperhub: {
      apiBase: str(env, 'KH_API_BASE', 'https://app.keeperhub.com'),
      mcpUrl: str(env, 'KH_MCP_URL', 'https://app.keeperhub.com/mcp'),
      apiKey: optional(env, 'KH_API_KEY'),
      marketplaceSlug: str(env, 'KH_MARKETPLACE_SLUG', 'assay-verify'),
    },
    chain: { id: chainId, paymentChainId },
    contracts: {
      intentRegistry: address(env, 'INTENT_REGISTRY'),
      receiptRegistry: address(env, 'RECEIPT_REGISTRY'),
      verifier: address(env, 'ORG_WALLET_ADDRESS'),
    },
    agent: {
      maxExecutionsPerDay: int(env, 'MAX_EXECUTIONS_PER_DAY', 200),
      maxValuePerTx: big(env, 'MAX_VALUE_PER_TX', 5_000_000n),
      intentTtlSeconds: int(env, 'INTENT_TTL_SECONDS', 900),
      maxAttempts: int(env, 'MAX_ATTEMPTS', 3),
      killSwitch: bool(env, 'KILL_SWITCH', false),
      tickIntervalMs: int(env, 'TICK_INTERVAL_MS', 60_000),
    },
    observer: {
      rpcUrls,
      quorum,
      blockscoutUrl: optional(env, 'BLOCKSCOUT_URL'),
      timeoutMs: int(env, 'OBSERVER_TIMEOUT_MS', 10_000),
    },
  };
}

/**
 * Assertions for code paths that are about to do something irreversible.
 *
 * Kept separate from `loadConfig` so that read-only tools (the explorer, the
 * MCP server's query tools) can boot with partial configuration.
 */
export function assertCanExecute(config: AssayConfig): void {
  if (!config.keeperhub.apiKey) {
    throw new ConfigError('KH_API_KEY is required to execute through KeeperHub');
  }
  if (config.agent.killSwitch) {
    throw new ConfigError('KILL_SWITCH is set; refusing to execute');
  }
  if (!config.contracts.intentRegistry) {
    throw new ConfigError('INTENT_REGISTRY must be set before committing intents');
  }
  if (!config.contracts.receiptRegistry) {
    throw new ConfigError('RECEIPT_REGISTRY must be set before writing receipts');
  }
}

export function assertCanObserveIndependently(config: AssayConfig): void {
  if (config.observer.rpcUrls.length === 0) {
    throw new ConfigError(
      'RPC_URLS must list at least one endpoint that is not the executor’s, ' +
        'otherwise the verdict would be circular',
    );
  }
  if (config.observer.rpcUrls.length < config.observer.quorum) {
    throw new ConfigError(
      `OBSERVER_QUORUM is ${config.observer.quorum} but only ` +
        `${config.observer.rpcUrls.length} RPC endpoint(s) are configured`,
    );
  }
}

export function assertCanPay(config: AssayConfig): void {
  if (!canSignWithAgenticWallet(config.chain.paymentChainId)) {
    throw new ConfigError(
      `PAYMENT_CHAIN_ID ${config.chain.paymentChainId} is not a chain KeeperHub's agentic ` +
        'wallet can sign on (Base 8453, Tempo 4217, Tempo testnet 42431)',
    );
  }
}

/** True when every configured chain is a testnet. Used to gate loud warnings. */
export function isFullyTestnet(config: AssayConfig): boolean {
  return isTestnet(config.chain.id) && isTestnet(config.chain.paymentChainId);
}

export { ConfigError };
