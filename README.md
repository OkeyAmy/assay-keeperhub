# Assay — Proof of Execution for Onchain Agents

> **x402 pays an agent for a promise. Assay proves the promise was kept.**
>
> Assay commits an agent's intent onchain *before* KeeperHub executes, then
> reconciles KeeperHub's own audit trail against chain state read through
> *different* providers, and writes a hash-chained pass/fail receipt onchain —
> also through KeeperHub.

**152 tests** — 117 TypeScript (Vitest) + 35 Solidity (Foundry, incl. 6 fuzz suites at 1,000 runs each). All green.
Built for the [KeeperHub "Agents Onchain" hackathon](https://dorahacks.io/hackathon/agents-onchain/detail).

· [Transactions](./TRANSACTIONS.md) · [Setup](./docs/SETUP.md) · [Usage](./docs/USAGE.md) · [Commands](./docs/COMMANDS.md) · [Testing](./docs/TESTING.md) · [KeeperHub integration](./docs/KEEPERHUB.md)

```bash
pnpm install && pnpm verify     # boundaries + 152 tests + failure gauntlet
pnpm gauntlet                   # see the product in 10 seconds, no credentials
```

---

## The problem

KeeperHub solved the last mile: a decision becomes a transaction that lands. But
**landing is not the same as being correct.**

1. **`status: success` ≠ "did the right thing."** A run can report success with a
   valid tx hash while the transaction paid the wrong recipient, moved the wrong
   amount, or reverted internally.
2. **The audit trail is self-reported.** It is excellent operational telemetry
   and unusable as evidence, because the executor writes it.
3. **The marketplace is a black box you pay for.** Workflow logic stays private
   by design — so a calling agent pays USDC into logic it cannot inspect.

Assay is the independent verify layer. It is the third leg of the read/execute
split KeeperHub and Blockscout [argued for](https://keeperhub.com/blog/011-detect-decide-execute-blockscout):
**the thing checking the executor is not the executor.**

## How it works

```
   ┌── @assay/agent ───────────────────────────────────────────────┐
   │                                                               │
   │  1. commit(intentHash)  ──────────────┐                       │
   │     hash of what it is about to do    │                       │
   │                                       ▼                       │
   │  2. execute the action        ┌──────────────┐   tx 1,2,3     │
   │     (a real value movement)   │  KeeperHub   │──────────────► chain
   │                               │  Direct Exec │                │
   │  3. reconcile ◄───audit trail─└──────────────┘                │
   │        ▲                                                      │
   │        │  independent read (NEVER through KeeperHub)          │
   │        └──── @assay/observer ── Blockscout + 2× RPC quorum ◄── chain
   │                                                               │
   │  4. write(receipt)  hash-chained verdict ─────────────────────┘
   └───────────────────────────────────────────────────────────────┘
```

**Three KeeperHub-executed transactions per cycle**: intent commitment, the
value-moving action, the verification receipt.

### The four checks

| Check | Catches | Verdict on failure |
|---|---|---|
| **Existence** | Missing tx hash on sponsored/7702 executions ([KeeperHub #1784](https://github.com/KeeperHub/keeperhub/issues/1784)) | `UNPROVEN` |
| **Conformance** | Template-binding bugs, stale `{{...}}` refs, decimal errors, wrong recipient | `DIVERGENT` |
| **Effect** | "Success" on a tx that reverted or was a no-op; balance deltas outside declared bounds | `DIVERGENT` |
| **Liveness** | Retries replaying a cached failure and never resubmitting ([KeeperHub #1840](https://github.com/KeeperHub/keeperhub/issues/1840)) | `DIVERGENT` |

`UNPROVEN` is a first-class answer. A verifier that cannot say *"I could not
tell"* will eventually say `VERIFIED` when it means `UNPROVEN`, and at that
point it is worse than no verifier at all. **Nothing in this codebase upgrades
an `UNPROVEN` to a `VERIFIED`.**

## Quick start

```bash
pnpm install
cp .env.example .env      # fill in KH_API_KEY and RPC_URLS

pnpm verify               # boundaries + 152 tests + gauntlet, all of the below
```

Individually:

```bash
pnpm test                 # 117 TypeScript tests (Vitest)
pnpm test:contracts       #  35 Solidity tests (Foundry)
pnpm lint:boundaries      # structural independence check
pnpm gauntlet             # four failure scenarios — no credentials needed
pnpm live:observer        # prove the read path against real public RPC — no credentials needed

pnpm run doctor           # validate setup against the real APIs
pnpm run agent:once       # one full cycle
pnpm run agent            # run continuously
pnpm dev                  # receipts explorer
```

**`pnpm gauntlet` and `pnpm live:observer` need no configuration at all** — the
fastest way to see both halves of the product: the reconciler catching failures,
and the independent read path talking to a real chain.

### Deploying the registries

```bash
cd contracts
DEPLOYER_PRIVATE_KEY=0x... DEPLOY_RPC_URL=https://... pnpm run deploy
# then put the printed addresses in .env
```

This is the **only** place a raw private key is used. Deployment is setup; every
*agent* transaction goes through KeeperHub. See [Boundaries](#boundaries).

## Repo layout

```
packages/
  core/         Intent, Verdict, reconcile(), receipts, idempotency  — pure, no I/O, no vendor
  observer/     Independent reads: multi-RPC quorum + Blockscout      — no execution provider
  keeperhub/    Direct Execution API, audit trail, retry              — the ONLY thing that submits
  config/       Env + chain registry                                  — the only reader of process.env
  agent/        The commit→execute→reconcile→receipt cycle, policy, strategies
apps/
  runner/       Long-running agent + `doctor` diagnostics
  mcp/          MCP server: assay_verify, assay_hash_intent, assay_receipts, assay_status
  dashboard/    Receipts explorer
contracts/
  src/          IntentRegistry.sol, ReceiptRegistry.sol
scripts/
  gauntlet/     Four failure injections
  check-boundaries.mjs
  marketplace/  The published assay-verify workflow, as source
  live/         Read-path check against a real chain
```

## Boundaries

The central claim is enforced structurally, not documented and hoped for.
`pnpm lint:boundaries` fails the build if:

1. `@assay/core` or `@assay/observer` import any execution provider — if the
   reconciler could read through KeeperHub it would agree with KeeperHub by
   construction, and every verdict would be circular.
2. Anything outside `@assay/keeperhub` calls `writeContract`, `sendTransaction`,
   `createWalletClient` or `privateKeyToAccount` — every agent-initiated
   transaction must go through KeeperHub.

## KeeperHub surfaces used

Stated as built, not as intended. A verifier that overstates its own coverage
has picked a strange hill to die on.

| Surface | Status | Where |
|---|---|---|
| **Audit trail** | shipped | `packages/keeperhub/src/audit.ts` — **the reconciler's primary input**, not logging |
| **Direct Execution API** | shipped | `packages/keeperhub/src/execute.ts` — simulate → execute → poll |
| **Idempotency** | shipped | `packages/core/src/idempotency.ts` — per-attempt, per-scope keys, avoiding #1840 |
| **Smart gas** | shipped | `packages/keeperhub/src/retry.ts` — escalating `gasLimitMultiplier` |
| **MCP** | shipped | `apps/mcp` — five tools, live against Sepolia |
| **CLI** | documented only | `kh run logs` / `kh run status` in the ops runbook; not a code dependency |
| **Workflow builder / Marketplace** | shipped | Published as [`assay-verify`](https://app.keeperhub.com/marketplace); built and listed via their MCP server by `scripts/marketplace/publish.ts` |
| **x402** | live, unsettled | The listing serves a real 402 challenge — `exact` scheme, 0.01 USDC on Base (`eip155:8453`), discoverable in the x402 Bazaar. No payment has settled yet: that needs a caller holding USDC on Base mainnet |
| **MPP** | **not built** | Tempo is configured as the alternate settlement chain, but no MPP path is implemented |
| **ERC-8004 reputation** | automatic | KeeperHub registers callers on the ReputationRegistry — this deployment is agent [`31875`](https://8004scan.io/agents/ethereum/31875) |

Across ~50 public repos tagged to this hackathon, **no other submission treats
KeeperHub's execution logs as a first-class input.** Most gate *before*
execution; Assay checks what the executor said *afterwards*.

Protocol quirks handled and cited at their call sites — string-typed
`chainId`/`functionArgs` ([#1841](https://github.com/KeeperHub/keeperhub/issues/1841)),
idempotency replay wedging retries ([#1840](https://github.com/KeeperHub/keeperhub/issues/1840)),
executions with no `txHash` ([#1784](https://github.com/KeeperHub/keeperhub/issues/1784)),
would-revert arriving as HTTP 400, and three distinct 409 conditions.
Full detail in [docs/KEEPERHUB.md](./docs/KEEPERHUB.md).

## Verifying Assay itself

A verifier you cannot check is just another black box.

```bash
pnpm lint:boundaries   # the reconciler structurally cannot read through KeeperHub
pnpm gauntlet          # four failure modes           — no credentials needed
pnpm live:observer     # real chain reads, 3 providers — no credentials needed
```

Onchain, with nothing from this repo:

```bash
cast call $RECEIPT_REGISTRY "summary(address)(uint256,uint256,uint256,uint256)" $VERIFIER --rpc-url $RPC
# verified divergent unproven notExecuted
```

A verifier whose tally is all `VERIFIED` and never `DIVERGENT` or `UNPROVEN` is
itself a finding. That number is cheap to read on purpose.

## Live deployment

Running on **Ethereum Sepolia**, executing through KeeperHub's Direct Execution
API and reading through four independent RPC providers:

| | |
|---|---|
| IntentRegistry | [`0x75Fd7a39c85E34EFaD09EbCE39dc0d0e4AE4E561`](https://sepolia.etherscan.io/address/0x75Fd7a39c85E34EFaD09EbCE39dc0d0e4AE4E561) |
| ReceiptRegistry | [`0x3a5D1FC35736Bdb1656bb35Ce1503B62FAa5d4cA`](https://sepolia.etherscan.io/address/0x3a5D1FC35736Bdb1656bb35Ce1503B62FAa5d4cA) |

Anyone can read the tally without this repository:

```bash
cast call 0x3a5D1FC35736Bdb1656bb35Ce1503B62FAa5d4cA \
  "summary(address)(uint256,uint256,uint256,uint256)" \
  0x39D438c6C41168DB49DcAe73Fc0D8a6D5D48Aa57 \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

That tally is **not** all `VERIFIED`, and it is not meant to be. The
`DIVERGENT` and `UNPROVEN` entries are real findings from bringing this up
against live infrastructure — each one is explained, and fixed, in
[SETUP.md](./docs/SETUP.md#failures-found-while-bringing-this-up-on-real-infrastructure).
A verifier with a spotless record is a verifier that is not looking.

## Configuration

Everything is environment-driven; nothing is hardcoded. See
[`.env.example`](./.env.example).

Defaults target **testnets** — Ethereum Sepolia for execution, Tempo testnet for
x402/MPP payments. (Base Sepolia is deliberately not used: KeeperHub's agentic
wallet signs only on Base mainnet, Tempo mainnet and Tempo testnet.) Pointing at
a mainnet requires changing `CHAIN_ID` yourself, and the runner prints a warning
when you do.

The optional reasoning layer is **provider-agnostic** — the OpenAI SDK against a
configurable `LLM_BASE_URL`, so Gemini, OpenAI, OpenRouter, Groq or a local
Ollama all work. The model **never decides a verdict**; `reconcile()` is
deterministic and the model only explains results.

## Disclosure

This repository began from an earlier personal project of mine — an
ERC-8004/ERC-7857 agent trust passport — and reuses scaffolding from it:

- the Foundry harness and `foundry.toml`
- EIP-712 hashing helpers
- the Next.js application shell
- CI workflow configuration

`ReceiptRegistry.sol` is a **rewrite**, informed by that project's ERC-8004
`ValidationRegistry` but sharing no logic with it.

Everything the submission is actually judged on is new for this hackathon: the
reconciler and its four checks, the KeeperHub integration, the independent
observer, both registry contracts, the agent cycle, and the marketplace
workflow.

The predecessor's source is **not** vendored here. Carrying ~140 files of dead
code purely to evidence a disclosure would make the repository harder to review
for no benefit, and the reuse above is stated precisely enough to check against
the git history.

## License

Apache-2.0. See [LICENSE](./LICENSE).
