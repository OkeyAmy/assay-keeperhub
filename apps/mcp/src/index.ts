#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { decodeFunctionData, parseAbi } from 'viem';
import {
  enableDualStackFallback,
  explorerTxUrl,
  loadConfig,
  loadEnvFile,
} from '@assay/config';
import { hashIntent, verdictFromCode, type Intent } from '@assay/core';
import { AuditCollector, DirectExecutor, KeeperHubClient } from '@assay/keeperhub';
import { observeAbsent, observeTransaction, RpcPool } from '@assay/observer';
import { reconcile } from '@assay/core';
import { Registries } from '@assay/agent';

/**
 * Assay as an MCP server.
 *
 * This is how another agent — including the ones judging this, and including
 * other hackathon submissions — buys verification without cloning anything.
 * The same surface is published as a paid KeeperHub marketplace workflow.
 *
 * Every tool here is read-and-verify. Nothing in this server moves value; the
 * only writes Assay performs happen in the runner, through KeeperHub.
 */
// Stdio servers inherit the caller's cwd, which is rarely the workspace root.
loadEnvFile();
enableDualStackFallback();
const config = loadConfig();

const pool = new RpcPool(config.chain.id, config.observer);
const khClient = config.keeperhub.apiKey ? new KeeperHubClient(config.keeperhub) : undefined;
const audit = khClient ? new AuditCollector(khClient) : undefined;
const executor = khClient ? new DirectExecutor(khClient) : undefined;
// Built from the registry addresses alone. `executor` may be undefined here —
// every tool this server exposes is a chain read, and requiring the executor's
// API key to read would make the independent path depend on the party being
// verified. A caller with only RPC_URLS gets the full read surface.
const registries = config.contracts.receiptRegistry
  ? new Registries(executor, pool, config.contracts, config.chain.id)
  : undefined;

const server = new McpServer({ name: 'assay', version: '0.1.0' });

/** The intent shape, as an agent would supply it over the wire. */
const intentSchema = z.object({
  chainId: z.number().int(),
  target: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  selector: z.string().regex(/^0x[0-9a-fA-F]{8}$/),
  args: z.string().regex(/^0x[0-9a-fA-F]*$/),
  value: z.string().default('0'),
  bounds: z.object({
    balanceDeltas: z
      .array(
        z.object({
          token: z.string(),
          account: z.string(),
          min: z.string(),
          max: z.string(),
        }),
      )
      .default([]),
    requiredTopics: z.array(z.string()).default([]),
    maxGasUsed: z.string().default('0'),
  }),
  deadline: z.string(),
  nonce: z.string(),
  policyHash: z.string(),
});

function toIntent(raw: z.infer<typeof intentSchema>): Intent {
  return {
    chainId: raw.chainId,
    target: raw.target as `0x${string}`,
    selector: raw.selector as `0x${string}`,
    args: raw.args as `0x${string}`,
    value: BigInt(raw.value),
    bounds: {
      balanceDeltas: raw.bounds.balanceDeltas.map((d) => ({
        token: d.token as `0x${string}`,
        account: d.account as `0x${string}`,
        min: BigInt(d.min),
        max: BigInt(d.max),
      })),
      requiredTopics: raw.bounds.requiredTopics as `0x${string}`[],
      maxGasUsed: BigInt(raw.bounds.maxGasUsed),
    },
    deadline: BigInt(raw.deadline),
    nonce: BigInt(raw.nonce),
    policyHash: raw.policyHash as `0x${string}`,
  };
}

/**
 * Turn a committed intent into the plain-language description a caller like
 * Claude would actually want to say out loud.
 *
 * The gap this closes: `assay_verify` takes the full intent as raw
 * chain/target/selector/args/bounds, verifies against it, and used to return
 * only the verdict and the transaction hash — leaving nothing readable for the
 * calling agent to narrate except "the tx did X or didn't." The intent itself
 * *is* the human-meaningful part (what was promised), so it is decoded here
 * rather than left as bytes.
 *
 * The call itself (function name and arguments) can only be named if the
 * caller supplies how to read it — a 4-byte selector alone is not reversible.
 * Without one, the calldata is shown as bytes rather than guessed at; a wrong
 * guess at what a call does is worse than an honest "not decoded."
 */
function describeIntent(intent: Intent, functionSignature?: string): Record<string, unknown> {
  const deadlineIso = new Date(Number(intent.deadline) * 1000).toISOString();

  let call: string;
  if (functionSignature) {
    try {
      // viem validates ABI signatures at the type level via a template-literal
      // brand, which only works for string literals known at compile time.
      // This one arrives at runtime from the caller, so the cast is required;
      // parseAbi still throws at runtime on a malformed signature, which the
      // catch below turns into an honest "not decoded" instead of a crash.
      const abi = parseAbi([`function ${functionSignature}`] as readonly string[]);
      const data = `${intent.selector}${intent.args.slice(2)}` as `0x${string}`;
      const decoded = decodeFunctionData({ abi, data });
      call = `${decoded.functionName}(${(decoded.args ?? []).map(String).join(', ')})`;
    } catch (error) {
      call = `${intent.selector} (given signature did not match the calldata: ${
        error instanceof Error ? error.message : String(error)
      })`;
    }
  } else {
    call = `${intent.selector} (pass functionSignature, e.g. "transfer(address to, uint256 amount)", to decode this)`;
  }

  return {
    chainId: intent.chainId,
    target: intent.target,
    call,
    nativeValueWei: intent.value.toString(),
    declaredEffects: {
      balanceDeltas: intent.bounds.balanceDeltas.map((d) => ({
        token: d.token,
        account: d.account,
        expectedDelta: `[${d.min}, ${d.max}] wei`,
      })),
      requiredEventTopics: intent.bounds.requiredTopics,
      maxGasUsed: intent.bounds.maxGasUsed.toString(),
    },
    deadline: deadlineIso,
  };
}

function text(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, bigintReplacer, 2) }],
  };
}

function bigintReplacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * The headline tool: verify somebody else's KeeperHub execution.
 *
 * Takes an execution id and the intent it was supposed to fulfil, pulls
 * KeeperHub's audit trail, reads the chain through independent providers, and
 * returns a verdict. The caller need not be the party that executed.
 */
server.registerTool(
  'assay_verify',
  {
    title: 'Verify a KeeperHub execution against a committed intent',
    description:
      'Reconciles what KeeperHub reports for an execution against what independent ' +
      'RPC providers actually observe onchain. Returns VERIFIED, DIVERGENT, UNPROVEN ' +
      'or NOT_EXECUTED with a per-check breakdown. UNPROVEN is a real answer: it means ' +
      'the evidence was insufficient, not that the execution was fine.',
    inputSchema: {
      executionId: z.string().describe('KeeperHub execution id, e.g. direct_123'),
      intent: intentSchema.describe('The intent the execution was supposed to fulfil'),
      functionSignature: z
        .string()
        .optional()
        .describe(
          'Optional, e.g. "transfer(address to, uint256 amount)". Lets the response name the ' +
            'call instead of showing only its raw 4-byte selector — the selector alone cannot ' +
            'be reversed into a function name.',
        ),
    },
  },
  async ({ executionId, intent: rawIntent, functionSignature }) => {
    if (!audit) {
      return text({ error: 'KH_API_KEY is not configured; cannot read the audit trail' });
    }

    const intent = toIntent(rawIntent);
    const intentSummary = describeIntent(intent, functionSignature);
    const status = await audit.getStatus(executionId);

    const trail = {
      executionId,
      status: status.mapped,
      txHash: status.txHash,
      chainId: intent.chainId,
      gasUsed: status.gasUsedWei,
      attempts: [{ index: 0, status: status.mapped === 'success' ? ('success' as const) : ('error' as const) }],
      error: status.error,
    };

    const observation = status.txHash
      ? await observeTransaction(pool, status.txHash, intent)
      : await observeAbsent(pool);

    const verdict = reconcile(intent, trail, observation);

    return text({
      // Listed first on purpose: this is what a promise was made to do — the
      // thing an agent narrating this result should say before the verdict.
      intent: intentSummary,
      verdict: verdict.kind,
      reason: verdict.reason,
      detail: verdict.detail,
      checks: verdict.checks,
      intentHash: verdict.intentHash,
      txHash: verdict.txHash,
      explorer: verdict.txHash ? explorerTxUrl(intent.chainId, verdict.txHash) : undefined,
      independentProviders: observation.agreementCount,
      quorumRequired: observation.quorumRequired,
    });
  },
);

/** Hash an intent, so a caller can commit it or compare against a commitment. */
server.registerTool(
  'assay_hash_intent',
  {
    title: 'Compute the canonical hash of an intent',
    description:
      'Returns the canonical intent hash used for onchain commitment. Bounds are ' +
      'sorted before hashing, so logically identical intents hash identically ' +
      'regardless of field order.',
    inputSchema: {
      intent: intentSchema,
      functionSignature: z
        .string()
        .optional()
        .describe('Optional, e.g. "transfer(address to, uint256 amount)", to name the call in the response.'),
    },
  },
  async ({ intent, functionSignature }) => {
    const built = toIntent(intent);
    return text({
      intentHash: hashIntent(built),
      intent: describeIntent(built, functionSignature),
    });
  },
);

/** Was this intent committed before it was executed? */
server.registerTool(
  'assay_check_commitment',
  {
    title: 'Check whether an intent was committed onchain',
    description:
      'Returns whether the intent hash exists in the IntentRegistry. An execution ' +
      'whose intent was never committed cannot be held to anything, because there ' +
      'is no prior promise to compare it against.',
    inputSchema: { intentHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) },
  },
  async ({ intentHash }) => {
    if (!registries) return text({ error: 'INTENT_REGISTRY is not configured' });
    return text({
      intentHash,
      committed: await registries.isCommitted(intentHash as `0x${string}`),
    });
  },
);

/** The public verdict tally for a verifier. */
server.registerTool(
  'assay_receipts',
  {
    title: 'Read the onchain receipt summary for a verifier',
    description:
      'Returns how many VERIFIED, DIVERGENT, UNPROVEN and NOT_EXECUTED receipts a ' +
      'verifier has written, plus the head of its hash chain. A verifier that has ' +
      'only ever reported VERIFIED is itself a finding.',
    inputSchema: { verifier: z.string().regex(/^0x[0-9a-fA-F]{40}$/) },
  },
  async ({ verifier }) => {
    if (!registries) return text({ error: 'RECEIPT_REGISTRY is not configured' });
    const address = verifier as `0x${string}`;
    const [summary, head, total] = await Promise.all([
      registries.summary(address),
      registries.getHead(address),
      registries.totalReceipts(),
    ]);
    return text({
      verifier,
      summary,
      chainHead: head,
      totalReceiptsAllVerifiers: total,
      verdictCodes: { VERIFIED: 1, DIVERGENT: 2, UNPROVEN: 3, NOT_EXECUTED: 4 },
    });
  },
);

/** What this deployment is pointed at. Useful for judges checking independence. */
server.registerTool(
  'assay_status',
  {
    title: 'Report this Assay deployment’s configuration',
    description:
      'Shows the target chain, how many independent RPC providers back the read ' +
      'path, and which registries are configured. The independent provider count ' +
      'is the thing that makes a verdict non-circular.',
    inputSchema: {},
  },
  async () => {
    const tip = await pool.getBlockNumber();
    return text({
      chainId: config.chain.id,
      paymentChainId: config.chain.paymentChainId,
      independentRpcProviders: pool.providerCount,
      quorumRequired: pool.quorum,
      providersAgreeingNow: tip.agreementCount,
      chainTip: tip.value,
      intentRegistry: config.contracts.intentRegistry,
      receiptRegistry: config.contracts.receiptRegistry,
      keeperhubConfigured: Boolean(khClient),
      marketplaceSlug: config.keeperhub.marketplaceSlug,
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

export { verdictFromCode };
