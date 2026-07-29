import { encodeAbiParameters, parseAbiParameters, type Abi, type Address, type Hex } from 'viem';
import type { AgentConfig } from '@assay/config';
import { hashPolicy, type Intent } from '@assay/core';
import type { RpcPool } from '@assay/observer';
import { ERC20_BALANCE_ABI } from '@assay/observer';
import type { ActionPlan } from '../cycle.js';

/**
 * The demo strategy: move a small amount of an ERC-20 to a treasury address.
 *
 * Deliberately unclever. The product is the proof, not the alpha — a strategy
 * interesting enough to argue about would distract from the thing being
 * demonstrated, which is that the execution can be held to its commitment.
 *
 * What matters here is that the intent declares *falsifiable* effects: exact
 * balance deltas on both sides and a required Transfer event. An intent that
 * cannot fail its own check proves nothing.
 */
export class TreasuryStrategy {
  private nonce: bigint;

  constructor(
    private readonly params: TreasuryParams,
    private readonly pool: RpcPool,
    private readonly agentConfig: AgentConfig,
    startingNonce = 0n,
  ) {
    this.nonce = startingNonce;
  }

  /**
   * Decide whether to act, and if so produce a fully specified plan.
   *
   * Idling reports *why*. "Nothing to do" and "the independent read path could
   * not tell me the balance" look identical from outside and mean opposite
   * things — the first is the strategy working, the second is the observer
   * degraded, and an operator who cannot distinguish them will assume the first.
   */
  async plan(): Promise<PlanResult> {
    const balance = await this.readBalance(this.params.from);
    if (balance === undefined) {
      // Cannot see the balance, so cannot bound the effect. Do not guess.
      return {
        idle: true,
        reason: `balance of ${this.params.token} for ${this.params.from} did not reach observer quorum`,
      };
    }

    if (balance < this.params.minBalanceToAct) {
      return {
        idle: true,
        reason: `balance ${balance} is below the ${this.params.minBalanceToAct} threshold to act`,
      };
    }

    const amount = this.params.amountPerMove;
    if (amount > balance) {
      return { idle: true, reason: `balance ${balance} cannot cover a move of ${amount}` };
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    const deadline = now + BigInt(this.agentConfig.intentTtlSeconds);

    const intent: Intent = {
      chainId: this.params.chainId,
      target: this.params.token,
      selector: TRANSFER_SELECTOR,
      args: encodeAbiParameters(parseAbiParameters('address, uint256'), [this.params.to, amount]),
      value: 0n,
      bounds: {
        // Exact on both sides: a plain transfer has no slippage to absorb, so
        // widening these would only hide errors.
        balanceDeltas: [
          { token: this.params.token, account: this.params.from, min: -amount, max: -amount },
          { token: this.params.token, account: this.params.to, min: amount, max: amount },
        ],
        requiredTopics: [TRANSFER_TOPIC],
        maxGasUsed: this.params.maxGasUsed,
      },
      deadline,
      nonce: this.nonce++,
      policyHash: hashPolicy({
        maxValuePerTx: this.agentConfig.maxValuePerTx.toString(),
        maxExecutionsPerDay: this.agentConfig.maxExecutionsPerDay,
        intentTtlSeconds: this.agentConfig.intentTtlSeconds,
        strategy: 'treasury-sweep-v1',
      }),
    };

    return {
      intent,
      functionName: 'transfer',
      functionArgs: [this.params.to, amount],
      abi: ERC20_TRANSFER_ABI as unknown as Abi,
      valueMoved: amount,
      description: `transfer ${amount} of ${this.params.token} to ${this.params.to}`,
    };
  }

  private async readBalance(account: Address): Promise<bigint | undefined> {
    const result = await this.pool.readContract<bigint>({
      address: this.params.token,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [account],
    });
    return result.reachedQuorum ? result.value : undefined;
  }
}

/** Either something to do, or a stated reason there is nothing to do. */
export type PlanResult = ActionPlan | IdleReason;

export interface IdleReason {
  idle: true;
  reason: string;
}

export function isIdle(result: PlanResult): result is IdleReason {
  return 'idle' in result;
}

export interface TreasuryParams {
  chainId: number;
  token: Address;
  /** The KeeperHub org wallet the transfer leaves from. */
  from: Address;
  to: Address;
  amountPerMove: bigint;
  minBalanceToAct: bigint;
  maxGasUsed: bigint;
}

/** `transfer(address,uint256)` */
export const TRANSFER_SELECTOR: Hex = '0xa9059cbb';

/** `Transfer(address,address,uint256)` */
export const TRANSFER_TOPIC: Hex =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const satisfies Abi;
