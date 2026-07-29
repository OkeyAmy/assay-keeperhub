#!/usr/bin/env node
/**
 * Create and publish the `assay-verify` marketplace workflow.
 *
 * KeeperHub's REST surface exposes workflows read-only (`GET /api/workflows`
 * answers, `POST` returns 405). Creation and listing live on their MCP server,
 * so this drives that instead — which is also the surface the rubric names.
 *
 * The workflow itself is deliberately small. Marketplace logic stays private by
 * design, which is one of the accountability gaps this project exists to point
 * at; publishing something inspectable and boring is the honest response. It
 * reads two public view functions and returns what they say.
 *
 * Idempotent: re-running updates the existing workflow rather than creating a
 * second one, and re-listing preserves the original slug.
 *
 * Run: pnpm marketplace:publish
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enableDualStackFallback, loadEnvFile } from '@assay/config';

const MCP_URL = process.env.KH_MCP_URL ?? 'https://app.keeperhub.com/mcp';
const SLUG = process.env.KH_MARKETPLACE_SLUG ?? 'assay-verify';

/** The caller supplies these; every field is referenced by a workflow node. */
const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    intentHash: {
      type: 'string',
      description:
        'The canonical hash of the intent to check, as committed to IntentRegistry. Produce it with the assay_hash_intent MCP tool.',
      pattern: '^0x[0-9a-fA-F]{64}$',
    },
    verifier: {
      type: 'string',
      description: 'Address of the verifier whose public verdict record to return.',
      pattern: '^0x[0-9a-fA-F]{40}$',
    },
  },
  required: ['intentHash', 'verifier'],
} as const;

const OUTPUT_MAPPING = {
  committedBeforeExecution: '{{@step-1:Check Intent Commitment.result}}',
  verifierRecord: '{{@step-2:Read Verifier Record.result}}',
} as const;

async function main(): Promise<number> {
  loadEnvFile();
  enableDualStackFallback();

  const apiKey = process.env.KH_API_KEY;
  if (!apiKey) {
    console.error('KH_API_KEY is required to publish.');
    return 1;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const definition = JSON.parse(readFileSync(resolve(here, 'workflow.json'), 'utf8'));
  // Strip documentation-only keys; the API rejects unknown fields.
  for (const key of Object.keys(definition)) {
    if (key.startsWith('_comment')) delete definition[key];
  }

  const mcp = new McpSession(MCP_URL, apiKey);
  await mcp.open();

  // Reuse an existing workflow of the same name so publishing twice does not
  // litter the account with duplicates.
  const existing = await findByName(mcp, definition.name);

  let workflowId: string;
  if (existing) {
    console.log(`updating existing workflow ${existing}`);
    await mcp.call('update_workflow', { workflowId: existing, ...definition });
    workflowId = existing;
  } else {
    const created = await mcp.call('create_workflow', definition);
    workflowId = extractId(created);
    console.log(`created workflow ${workflowId}`);
  }

  const validation = await mcp.call('validate_workflow', { workflowId });
  console.log('validation:', summarise(validation));

  const listed = await mcp.call('list_workflow', {
    workflowId,
    slug: SLUG,
    category: 'monitoring',
    chain: '11155111',
    inputSchema: INPUT_SCHEMA,
    outputMapping: OUTPUT_MAPPING,
  });
  console.log('listing:', summarise(listed));

  // Read back through the *public* path — by slug, the way another agent finds
  // it — rather than by internal id. Publishing that only the publisher can see
  // is not publishing.
  const listing = await mcp.call('get_workflow_listing', { slug: SLUG });
  console.log('\npublished listing:\n' + summarise(listing));

  const discovery = await mcp.call('search_workflows', { query: 'assay' });
  console.log('\ndiscoverable via search_workflows:\n' + summarise(discovery));

  return 0;
}

/**
 * A minimal streamable-HTTP MCP client.
 *
 * The official SDK is a heavier dependency than one script justifies, and the
 * protocol here is three calls. Retries are generous because dual-stack hosts
 * with broken IPv6 routing make single attempts unreliable — see
 * `packages/config/src/net.ts`.
 */
class McpSession {
  private sessionId?: string;

  constructor(
    private readonly url: string,
    private readonly apiKey: string,
  ) {}

  async open(): Promise<void> {
    await this.post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'assay-publish', version: '1' },
      },
    });
    // Their server rejects tools/* until this notification lands, and requires
    // it to be sequential rather than pipelined.
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async call(name: string, args: unknown): Promise<unknown> {
    const body = await this.post({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e6),
      method: 'tools/call',
      params: { name, arguments: args },
    });
    const error = (body as { error?: { message?: string } })?.error;
    if (error) throw new Error(`${name}: ${error.message ?? JSON.stringify(error)}`);
    return body;
  }

  private async post(payload: unknown, attempts = 12): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await fetch(this.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });
        const sid = response.headers.get('mcp-session-id');
        if (sid) this.sessionId = sid;
        const text = await response.text();
        return parseJsonLoose(text);
      } catch {
        await sleep(1_500);
      }
    }
    throw new Error(`${this.url} unreachable after ${attempts} attempts`);
  }
}

/** Responses arrive as bare JSON or as an SSE frame wrapping it. */
function parseJsonLoose(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function findByName(mcp: McpSession, name: string): Promise<string | undefined> {
  const listed = await mcp.call('list_workflows', {});
  const text = toolText(listed);
  try {
    const rows = JSON.parse(text) as Array<{ id?: string; name?: string }>;
    return rows.find((row) => row.name === name)?.id;
  } catch {
    return undefined;
  }
}

function extractId(result: unknown): string {
  const text = toolText(result);
  const parsed = parseJsonLoose(text) as { id?: string; workflowId?: string } | null;
  const id = parsed?.id ?? parsed?.workflowId;
  if (!id) throw new Error(`could not read a workflow id from: ${text.slice(0, 300)}`);
  return id;
}

function toolText(result: unknown): string {
  const content = (result as { result?: { content?: Array<{ text?: string }> } })?.result?.content;
  return content?.[0]?.text ?? JSON.stringify(result);
}

function summarise(result: unknown): string {
  return toolText(result).slice(0, 700);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
