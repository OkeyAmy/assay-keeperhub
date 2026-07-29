import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  toHex,
  type Address,
  type Hex,
} from 'viem';

/**
 * What the agent commits to *before* anything moves.
 *
 * The whole product rests on this being canonical: two runs that mean the same
 * thing must hash the same, and two runs that differ in any way a caller would
 * care about must not. Anything ambiguous here becomes a false VERIFIED later.
 */
export interface Intent {
  /** EVM chain the action targets. */
  chainId: number;
  /** Contract the agent intends to call. */
  target: Address;
  /** 4-byte selector of the intended function. */
  selector: Hex;
  /** ABI-encoded arguments, without the selector. */
  args: Hex;
  /** Native value attached to the call, in wei. */
  value: bigint;
  /**
   * Declared effect bounds. The reconciler checks observed state against these
   * rather than against exact values, because slippage, rounding and
   * interest accrual make exact equality wrong for most real actions.
   */
  bounds: EffectBounds;
  /** Unix seconds after which this intent is void. */
  deadline: bigint;
  /** Monotonic per-agent counter. Prevents two identical intents colliding. */
  nonce: bigint;
  /** Hash of the policy the agent was operating under. Makes drift auditable. */
  policyHash: Hex;
}

/**
 * The observable consequences the agent claims its action will have.
 *
 * Expressed as inclusive ranges on token balance deltas for specific accounts.
 * A delta outside its range is a DIVERGENT verdict.
 */
export interface EffectBounds {
  /** Expected balance movements. Empty means "this call claims no balance effect". */
  balanceDeltas: BalanceDelta[];
  /** Event signatures that must appear in the receipt logs, by topic0. */
  requiredTopics: Hex[];
  /** Maximum gas the agent considers acceptable. 0n disables the check. */
  maxGasUsed: bigint;
}

export interface BalanceDelta {
  /** ERC-20 token, or the zero address for the chain's native asset. */
  token: Address;
  /** Account whose balance should move. */
  account: Address;
  /** Inclusive lower bound on (after - before). Negative means an outflow. */
  min: bigint;
  /** Inclusive upper bound on (after - before). */
  max: bigint;
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/** EIP-712 domain. Bound to the IntentRegistry so a commit cannot be replayed elsewhere. */
export function intentDomain(chainId: number, verifyingContract: Address) {
  return {
    name: 'Assay',
    version: '1',
    chainId,
    verifyingContract,
  } as const;
}

export const INTENT_TYPES = {
  Intent: [
    { name: 'chainId', type: 'uint256' },
    { name: 'target', type: 'address' },
    { name: 'selector', type: 'bytes4' },
    { name: 'argsHash', type: 'bytes32' },
    { name: 'value', type: 'uint256' },
    { name: 'boundsHash', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'policyHash', type: 'bytes32' },
  ],
} as const;

/**
 * Canonical hash of the declared effects.
 *
 * Deltas are sorted before hashing so that two intents expressing the same
 * constraints in a different order produce the same hash. Without this, the
 * hash would depend on JS object iteration order, which is not a property
 * anyone should be committing to onchain.
 */
export function hashBounds(bounds: EffectBounds): Hex {
  const sortedDeltas = [...bounds.balanceDeltas].sort(compareBalanceDelta);
  const sortedTopics = [...bounds.requiredTopics].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));

  const encodedDeltas = encodeAbiParameters(
    parseAbiParameters('(address token, address account, int256 min, int256 max)[]'),
    [sortedDeltas.map((d) => ({ token: d.token, account: d.account, min: d.min, max: d.max }))],
  );

  const encodedTopics = encodeAbiParameters(parseAbiParameters('bytes32[]'), [sortedTopics]);

  return keccak256(
    encodeAbiParameters(parseAbiParameters('bytes32, bytes32, uint256'), [
      keccak256(encodedDeltas),
      keccak256(encodedTopics),
      bounds.maxGasUsed,
    ]),
  );
}

function compareBalanceDelta(a: BalanceDelta, b: BalanceDelta): number {
  const keyA = `${a.token.toLowerCase()}:${a.account.toLowerCase()}`;
  const keyB = `${b.token.toLowerCase()}:${b.account.toLowerCase()}`;
  if (keyA !== keyB) return keyA < keyB ? -1 : 1;
  if (a.min !== b.min) return a.min < b.min ? -1 : 1;
  if (a.max !== b.max) return a.max < b.max ? -1 : 1;
  return 0;
}

/** Struct hash of an intent, in the shape the IntentRegistry expects. */
export function hashIntent(intent: Intent): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        'uint256, address, bytes4, bytes32, uint256, bytes32, uint256, uint256, bytes32',
      ),
      [
        BigInt(intent.chainId),
        intent.target,
        intent.selector,
        keccak256(intent.args),
        intent.value,
        hashBounds(intent.bounds),
        intent.deadline,
        intent.nonce,
        intent.policyHash,
      ],
    ),
  );
}

/** The full calldata this intent authorises: selector followed by args. */
export function intentCalldata(intent: Intent): Hex {
  return `${intent.selector}${intent.args.slice(2)}` as Hex;
}

/**
 * Does this calldata match what the intent authorised?
 *
 * Compared byte-for-byte on a lowercased basis. A near-miss is still a miss —
 * "close enough" is exactly the judgement call that lets a decimal error
 * through, so it is not offered.
 */
export function calldataMatchesIntent(intent: Intent, observed: Hex): boolean {
  return intentCalldata(intent).toLowerCase() === observed.toLowerCase();
}

export function isExpired(intent: Intent, nowSeconds: bigint): boolean {
  return nowSeconds > intent.deadline;
}

/**
 * Stable JSON for logging and receipt payloads.
 *
 * Keys are emitted in a fixed order and bigints as decimal strings, so the
 * serialisation is reproducible across processes and Node versions.
 */
export function serialiseIntent(intent: Intent): string {
  return JSON.stringify({
    chainId: intent.chainId,
    target: intent.target.toLowerCase(),
    selector: intent.selector.toLowerCase(),
    args: intent.args.toLowerCase(),
    value: intent.value.toString(),
    bounds: {
      balanceDeltas: [...intent.bounds.balanceDeltas].sort(compareBalanceDelta).map((d) => ({
        token: d.token.toLowerCase(),
        account: d.account.toLowerCase(),
        min: d.min.toString(),
        max: d.max.toString(),
      })),
      requiredTopics: [...intent.bounds.requiredTopics]
        .map((t) => t.toLowerCase())
        .sort() as Hex[],
      maxGasUsed: intent.bounds.maxGasUsed.toString(),
    },
    deadline: intent.deadline.toString(),
    nonce: intent.nonce.toString(),
    policyHash: intent.policyHash.toLowerCase(),
  });
}

/** Hash an arbitrary policy object into the `policyHash` field. */
export function hashPolicy(policy: unknown): Hex {
  return keccak256(toHex(JSON.stringify(policy)));
}
