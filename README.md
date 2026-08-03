# Assay — Proof of Execution for Onchain Agents

> **x402 pays an agent for a promise. Assay proves the promise was kept.**
>
> Assay commits an agent's intent onchain _before_ KeeperHub executes, then
> reconciles KeeperHub's own audit trail against chain state read through
> _different_ providers, and writes a hash-chained pass/fail receipt onchain —
> also through KeeperHub.

The reconciler is [four checks](#the-four-checks), open in `packages/core/src/reconcile.ts` —
existence, conformance, effect, liveness — plus **156 tests** (121 TypeScript/Vitest +
35 Solidity/Foundry, incl. 6 fuzz suites at 1,000 runs each) proving they hold. All green.
Built for the [KeeperHub "Agents Onchain" hackathon](https://dorahacks.io/hackathon/agents-onchain/detail).

**Live dashboard:** [assay-keeperhub.okeyamy.xyz](https://assay-keeperhub.okeyamy.xyz/) — see it running against real Sepolia infrastructure, nothing to install.

· [Transactions](./TRANSACTIONS.md) · [Setup](./docs/SETUP.md) · [Usage](./docs/USAGE.md) · [Commands](./docs/COMMANDS.md) · [Testing](./docs/TESTING.md) · [KeeperHub integration](./docs/KEEPERHUB.md)

```bash
pnpm install && pnpm gauntlet   # no credentials, no chain — the reconciler catching 4 failure modes in ~10s
pnpm verify                     # boundaries + 156 tests + gauntlet (needs Foundry for the Solidity half)
```

**[Try it](#try-it)** lays out five ways to exercise this, ordered by setup
cost — the first two need nothing installed.

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

| Check           | Catches                                                                                                                           | Verdict on failure |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **Existence**   | Missing tx hash on sponsored/7702 executions ([KeeperHub #1784](https://github.com/KeeperHub/keeperhub/issues/1784))              | `UNPROVEN`         |
| **Conformance** | Template-binding bugs, stale `{{...}}` refs, decimal errors, wrong recipient                                                      | `DIVERGENT`        |
| **Effect**      | "Success" on a tx that reverted or was a no-op; balance deltas outside declared bounds                                            | `DIVERGENT`        |
| **Liveness**    | Retries replaying a cached failure and never resubmitting ([KeeperHub #1840](https://github.com/KeeperHub/keeperhub/issues/1840)) | `DIVERGENT`        |

`UNPROVEN` is a first-class answer. A verifier that cannot say _"I could not
tell"_ will eventually say `VERIFIED` when it means `UNPROVEN`, and at that
point it is worse than no verifier at all. **Nothing in this codebase upgrades
an `UNPROVEN` to a `VERIFIED`.**

### The algorithm

`reconcile()` in [`packages/core/src/reconcile.ts`](./packages/core/src/reconcile.ts)
is a pure function — three inputs, one verdict, no I/O:

```
reconcile(intent, audit, observed):
  run existence(intent, audit, observed)

  # conformance and effect need a mined tx to reason about; running them
  # without one would produce confident-looking noise, not a check
  if existence passed AND observed.transaction exists:
    run conformance(intent, observed)
    run effect(intent, audit, observed)

  run liveness(audit)                 # always runs, independent of the rest

  verdict = VERIFIED
  for each check that failed:
    candidate = kindForReason(check.reason)
    if severity(candidate) > severity(verdict):
      verdict = candidate            # worst-wins, not first-wins
  return verdict
```

Severity is fixed and total: `NOT_EXECUTED` (3) > `DIVERGENT` (2) > `UNPROVEN`
(1) > `VERIFIED` (0) — [`packages/core/src/verdict.ts`](./packages/core/src/verdict.ts).
A `CALLDATA_MISMATCH` found by conformance is never masked by an earlier check
that merely came back `UNPROVEN`; there is no code path that ranks a check's
result by when it ran instead of what it found.

One wrinkle worth naming: KeeperHub's sponsored/7702 executions relay through
a wrapper contract, so the top-level `to` and calldata belong to the relayer,
not the intended target. `checkConformance` detects this (target reached only
via an inner call) and falls back to `checkRelayedConformance`, which demands
the intent declared a required event or balance bound it can check against the
target's own logs — an intent with no declared effect through a relayer is
`RELAYED_EFFECT_UNDECLARED`, not a free pass.

## Try it

Five rungs, ordered by setup cost. **The first two need nothing but a browser
and `curl`**, and each states what it actually proves — no rung asks you to take
on faith a claim that a later rung would settle.

### 1. Nothing installed — the live dashboard

**[assay-keeperhub.okeyamy.xyz](https://assay-keeperhub.okeyamy.xyz/)**

Every row is a real verdict on a real Sepolia execution. Expand any receipt's
**"Verify this receipt yourself"** panel: it hands you a `cast call` that reads
the same registry the page just read, straight from chain. Run it and you have
checked the page instead of trusting it — which is the point, because a
tamper-evidence tool you can only inspect through its own UI has not evidenced
anything.

### 2. `curl` only — read the chain directly

This deployment's verdict tally, straight from a public Sepolia node. No
Foundry, no repo, no account — the calldata is `summary(address)` against the
verifier:

```bash
curl -s -X POST https://ethereum-sepolia-rpc.publicnode.com \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x3a5D1FC35736Bdb1656bb35Ce1503B62FAa5d4cA","data":"0x9522a80a00000000000000000000000039d438c6c41168db49dcae73fc0d8a6d5d48aa57"},"latest"]}'
```

Four uint256 words come back — `verified, divergent, unproven, notExecuted`.
At the time of writing that decodes to `0x14, 0x06, 0x04, 0x00` = **20, 6, 4,
0**, matching what the dashboard shows and what [TRANSACTIONS.md](./TRANSACTIONS.md)
claims. With Foundry installed the same read is friendlier:

```bash
cast call 0x3a5D1FC35736Bdb1656bb35Ce1503B62FAa5d4cA \
  "summary(address)(uint256,uint256,uint256,uint256)" \
  0x39D438c6C41168DB49DcAe73Fc0D8a6D5D48Aa57 \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

And the marketplace listing serving a real x402 challenge:

```bash
curl -s -X POST https://app.keeperhub.com/api/mcp/workflows/assay-verify/call \
  -H 'content-type: application/json' -d '{}'
```

**Proves:** the receipts exist independently of this codebase and of the
dashboard, and the payment rail is live rather than described.

### 3. Clone, no credentials

Node and pnpm only:

```bash
pnpm install
pnpm gauntlet        # ~10s, no network: four failure modes injected, reconciler catches each
pnpm live:observer   # real Sepolia reads through independent providers
pnpm test            # 121 TypeScript tests
```

Which is which matters, so it is stated plainly rather than blurred into "demo":
`gauntlet` runs the reconciler against **synthetic** data we control, proving the
decision logic. `live:observer` runs the read path against a **real chain** we do
not control, proving the observation logic — including a provider timing out and
being counted as disagreement rather than silently skipped.

The full suite additionally needs [Foundry](https://getfoundry.sh) on `PATH`
for the 35 Solidity tests, or it will stop at `test:contracts` with
`forge: command not found`:

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
pnpm verify          # boundaries + 156 tests + gauntlet
```

### 4. Clone + `RPC_URLS` — the MCP server

Assay's read surface is an MCP server, so another agent can consume verdicts
without cloning anything. **Four of its five tools need no KeeperHub account** —
they are chain reads, and requiring the executor's credentials to *read* would
make the independent path depend on the party being verified:

| Tool | Needs |
|---|---|
| `assay_status` | `RPC_URLS` — chain, provider count, quorum, live agreement |
| `assay_receipts` | `RPC_URLS` + `RECEIPT_REGISTRY` — verdict tally and chain head |
| `assay_check_commitment` | `RPC_URLS` + `INTENT_REGISTRY` — was this intent committed first? |
| `assay_hash_intent` | nothing — pure function |
| `assay_verify` | `KH_API_KEY` — needs the executor's audit trail |

```bash
cp .env.example .env    # RPC_URLS and the registry addresses are already filled in
pnpm --filter @assay/mcp start
```

`assay_status` is the one to call first when deciding whether to trust a
deployment: it reports how many **independent** providers back the read path,
which is the thing that makes a verdict non-circular.

### 5. Full credentials — run the agent

```bash
cp .env.example .env      # add KH_API_KEY, ORG_WALLET_ADDRESS
cd contracts && DEPLOYER_PRIVATE_KEY=0x… DEPLOY_RPC_URL=https://… pnpm run deploy
                          # then put your own registry addresses in .env

pnpm run doctor           # validate setup against the real APIs before spending anything
pnpm run agent:once       # one full cycle: commit → execute → reconcile → receipt
pnpm run agent            # run continuously
pnpm dev                  # the receipts explorer, locally
```

Deploy your own registries before writing. The pre-filled addresses are read
defaults; receipt chains are per-verifier so writing to them cannot corrupt
anyone else's chain, but `totalReceipts()` is global and your receipts would mix
into this deployment's published tally.

`doctor` is deliberately a separate step: it checks the KeeperHub key, the RPC
quorum and the registry addresses *before* the agent moves value.

### Deploying the registries

```bash
cd contracts
DEPLOYER_PRIVATE_KEY=0x... DEPLOY_RPC_URL=https://... pnpm run deploy
# then put the printed addresses in .env
```

This is the **only** place a raw private key is used. Deployment is setup; every
_agent_ transaction goes through KeeperHub. See [Boundaries](#boundaries).

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

| Surface                            | Status          | Where                                                                                                                                                                                                      |
| ---------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Audit trail**                    | shipped         | `packages/keeperhub/src/audit.ts` — **the reconciler's primary input**, not logging                                                                                                                        |
| **Direct Execution API**           | shipped         | `packages/keeperhub/src/execute.ts` — simulate → execute → poll                                                                                                                                            |
| **Idempotency**                    | shipped         | `packages/core/src/idempotency.ts` — per-attempt, per-scope keys, avoiding #1840                                                                                                                           |
| **Smart gas**                      | shipped         | `packages/keeperhub/src/retry.ts` — escalating `gasLimitMultiplier`                                                                                                                                        |
| **MCP**                            | shipped         | `apps/mcp` — five tools, live against Sepolia                                                                                                                                                              |
| **CLI**                            | documented only | `kh run logs` / `kh run status` in the ops runbook; not a code dependency                                                                                                                                  |
| **Workflow builder / Marketplace** | shipped         | Published as [`assay-verify`](https://app.keeperhub.com/marketplace); built and listed via their MCP server by `scripts/marketplace/publish.ts`                                                            |
| **x402**                           | live, unsettled | The listing serves a real 402 challenge — `exact` scheme, 0.01 USDC on Base (`eip155:8453`), discoverable in the x402 Bazaar. No payment has settled yet: that needs a caller holding USDC on Base mainnet |
| **MPP**                            | **not built**   | Tempo is configured as the alternate settlement chain, but no MPP path is implemented                                                                                                                      |
| **ERC-8004 reputation**            | automatic       | KeeperHub registers callers on the ReputationRegistry — this deployment is agent [`31875`](https://8004scan.io/agents/ethereum/31875)                                                                      |

Assay treats KeeperHub's execution logs as a first-class input rather than as
logging: most guardians gate _before_ execution, while Assay checks what the
executor said _afterwards_, against an independent read of the chain.

Protocol quirks handled and cited at their call sites — string-typed
`chainId`/`functionArgs` ([#1841](https://github.com/KeeperHub/keeperhub/issues/1841)),
idempotency replay wedging retries ([#1840](https://github.com/KeeperHub/keeperhub/issues/1840)),
executions with no `txHash` ([#1784](https://github.com/KeeperHub/keeperhub/issues/1784)),
would-revert arriving as HTTP 400, and three distinct 409 conditions.
Full detail in [docs/KEEPERHUB.md](./docs/KEEPERHUB.md).

## Verifying Assay itself

A verifier you cannot check is just another black box. Three things are
therefore checkable without trusting anything here — see [Try it](#try-it) for
the commands:

1. **The independence is structural, not asserted.** `pnpm lint:boundaries`
   fails the build if the reconciler could read through KeeperHub.
2. **The decision logic is reproducible.** `pnpm gauntlet` injects four failure
   modes and shows the verdict for each, offline, in seconds.
3. **The record is public.** `cast call ... summary(...)` reads this
   deployment's tally with nothing from this repository involved.

A verifier whose tally is all `VERIFIED` and never `DIVERGENT` or `UNPROVEN` is
itself a finding. That number is cheap to read on purpose.

## Live deployment

Running on **Ethereum Sepolia**, executing through KeeperHub's Direct Execution
API and reading through four independent RPC providers.

**[assay-keeperhub.okeyamy.xyz](https://assay-keeperhub.okeyamy.xyz/)** is the
hosted receipts explorer — verdict tallies, every receipt with its intent
hash, tx link and block. It has no backend of its own: the page reads
`IntentRegistry`/`ReceiptRegistry` directly from chain through the same
independent RPC quorum the reconciler uses, no indexer and no database.
Tamper-evidence is worthless if checking it requires trusting a server, so the
dashboard doesn't ask you to. `pnpm dev` runs the same code locally.

|                 |                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| IntentRegistry  | [`0x75Fd7a39c85E34EFaD09EbCE39dc0d0e4AE4E561`](https://sepolia.etherscan.io/address/0x75Fd7a39c85E34EFaD09EbCE39dc0d0e4AE4E561) |
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

## Notes for judges

**Fastest path to testing this:** open the
[live dashboard](https://assay-keeperhub.okeyamy.xyz/), then run the one-line
`curl` in [rung 2](#2-curl-only--read-the-chain-directly) and check the numbers
it returns against what the page showed you. That is the whole trust argument in
about a minute, with nothing installed. [Try it](#try-it) has three more rungs
beyond that, ordered by setup cost.

Evidence, not a pitch — each line points at something checkable, not asserted:

- **The rubric-named surface is a data dependency, not a checkbox.** The audit
  trail feeds `reconcile()` directly (`packages/keeperhub/src/audit.ts`); see
  [KeeperHub surfaces used](#keeperhub-surfaces-used).
- **Independence is structural.** `pnpm lint:boundaries` fails the build if the
  reconciler or observer can import an execution provider — it cannot pass by
  accident later. See [Boundaries](#boundaries).
- **The live tally is not spotless, on purpose.** 20 `VERIFIED`, 6 `DIVERGENT`,
  4 `UNPROVEN` on Sepolia, readable with a bare `cast call` and nothing from
  this repo. Every `DIVERGENT`/`UNPROVEN` is a real bug found against live
  infrastructure, explained in
  [SETUP.md](./docs/SETUP.md#failures-found-while-bringing-this-up-on-real-infrastructure).
- **Protocol quirks are cited, not vague.** Three separate KeeperHub issues
  filed and linked at their call sites: missing `txHash` on sponsored/7702 runs
  ([#1784](https://github.com/KeeperHub/keeperhub/issues/1784)), idempotency
  replay wedging retries ([#1840](https://github.com/KeeperHub/keeperhub/issues/1840)),
  string-typed `chainId`/`functionArgs` ([#1841](https://github.com/KeeperHub/keeperhub/issues/1841)).
- **156 tests, 6 of them fuzzed at 1,000 runs**, plus `pnpm gauntlet` and
  `pnpm live:observer` — both runnable with zero credentials in under a minute.
- **What isn't built is stated plainly.** MPP: not implemented. x402: the 402
  challenge is live and `curl`-able, but no payment has settled. See
  [KeeperHub surfaces used](#keeperhub-surfaces-used).

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
