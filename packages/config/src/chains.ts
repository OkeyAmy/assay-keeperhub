import { base, baseSepolia, mainnet, sepolia, type Chain } from 'viem/chains';

/**
 * Tempo testnet, where KeeperHub's agentic wallet can sign MPP payments.
 *
 * Not shipped in viem/chains at the version we pin, so it is declared here.
 * Chain id and native currency come from KeeperHub's agentic-wallet docs, which
 * list signing support for Base (8453), Tempo mainnet (4217) and Tempo testnet
 * (42431). RPC and explorer URLs are overridable via env — see `resolveChain`.
 */
export const tempoTestnet = {
  id: 42431,
  name: 'Tempo Testnet',
  nativeCurrency: { name: 'Tempo', symbol: 'TEMPO', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.tempo.xyz'] } },
  blockExplorers: {
    default: { name: 'Tempo Explorer', url: 'https://explorer.testnet.tempo.xyz' },
  },
  testnet: true,
} as const satisfies Chain;

export const tempoMainnet = {
  id: 4217,
  name: 'Tempo',
  nativeCurrency: { name: 'Tempo', symbol: 'TEMPO', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.tempo.xyz'] } },
  blockExplorers: { default: { name: 'Tempo Explorer', url: 'https://explorer.tempo.xyz' } },
} as const satisfies Chain;

/**
 * Chains this project knows how to operate on.
 *
 * Membership here means "we have a viem chain definition", not "KeeperHub can
 * execute here" and not "the agentic wallet can sign here" — those are narrower
 * and are asserted separately below.
 */
export const SUPPORTED_CHAINS: Record<number, Chain> = {
  [mainnet.id]: mainnet,
  [sepolia.id]: sepolia,
  [base.id]: base,
  [baseSepolia.id]: baseSepolia,
  [tempoMainnet.id]: tempoMainnet,
  [tempoTestnet.id]: tempoTestnet,
};

/**
 * Chains KeeperHub's agentic wallet will sign on.
 *
 * From their agentic-wallet docs: "Signing is supported on Base (8453), Tempo
 * mainnet (4217), and Tempo testnet (42431) today." Base Sepolia is absent,
 * which is why the testnet payment leg runs on Tempo rather than Base Sepolia.
 */
export const AGENTIC_WALLET_SIGNING_CHAINS: readonly number[] = [
  base.id,
  tempoMainnet.id,
  tempoTestnet.id,
];

export function canSignWithAgenticWallet(chainId: number): boolean {
  return AGENTIC_WALLET_SIGNING_CHAINS.includes(chainId);
}

export function isTestnet(chainId: number): boolean {
  return SUPPORTED_CHAINS[chainId]?.testnet === true;
}

export function getChain(chainId: number): Chain {
  const chain = SUPPORTED_CHAINS[chainId];
  if (!chain) {
    const known = Object.keys(SUPPORTED_CHAINS).join(', ');
    throw new Error(`unsupported chain id ${chainId}; known chains: ${known}`);
  }
  return chain;
}

/**
 * A chain with its RPC endpoints replaced by explicitly configured ones.
 *
 * The verifier must read through providers that are not the executor's, so RPC
 * URLs are always supplied by configuration rather than defaulted silently.
 * Public defaults are only used when nothing is configured, and callers that
 * require independence assert on `urls.length` themselves.
 */
export function resolveChain(chainId: number, rpcUrls: string[]): Chain {
  const chain = getChain(chainId);
  if (rpcUrls.length === 0) return chain;
  return {
    ...chain,
    rpcUrls: { ...chain.rpcUrls, default: { http: rpcUrls } },
  };
}

export function explorerTxUrl(chainId: number, txHash: string): string | undefined {
  const base = SUPPORTED_CHAINS[chainId]?.blockExplorers?.default?.url;
  return base ? `${base}/tx/${txHash}` : undefined;
}

export function explorerAddressUrl(chainId: number, address: string): string | undefined {
  const base = SUPPORTED_CHAINS[chainId]?.blockExplorers?.default?.url;
  return base ? `${base}/address/${address}` : undefined;
}

export { base, baseSepolia, mainnet, sepolia };
export type { Chain };
