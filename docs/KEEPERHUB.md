# How Assay uses KeeperHub

For reviewers, judges, and anyone deciding whether this is a real integration or
a checkbox.

---

## Who KeeperHub is, and why this project looks the way it does

KeeperHub is built by the **Sky/MakerDAO devops team** (TechOps Services). Their
public writing is not about yield or alpha — it is almost entirely about
**silent offchain failure**:

- *"Two Oracle Failures. Thirty Days. The Same Root Cause."* — configuration drift
- *"The $25M Key That Wasn't in a Smart Contract"* — Resolv's offchain keys
- *"The $1.4B Hack a Single Automation Would Have Caught"* — Bybit

That is the scar tissue of infrastructure operators: **the system reported fine
and it was not fine.** Assay is that thesis turned into a product. It exists
because `status: success` and *"did the right thing"* are different claims, and
only one of them is currently checkable.

Their architecture post with Blockscout,
[*Why Onchain AI Agents Need a Read Layer and an Execute Layer*](https://keeperhub.com/blog/011-detect-decide-execute-blockscout),
argues that reading and executing are *"two distinct disciplines with different
failure modes."* Assay is the third leg that argument implies: an **independent
verify layer**, where the thing checking the executor is structurally incapable
of being the executor.

That is not a slogan here. `pnpm lint:boundaries` fails the build if
`@assay/core` or `@assay/observer` ever import an execution provider.

---

## Every surface, and where it lives

The rubric names several surfaces. Below is what is **actually built**, and what
is not. The deepest one — the audit trail — is a core data dependency rather
than a checkbox; the missing ones are named plainly rather than implied.

| Surface | Status | How it is used |
|---|---|---|
| **Audit trail** | shipped | **The reconciler's primary input.** Not logging — the thing being verified (`packages/keeperhub/src/audit.ts`) |
| **Direct Execution API** | shipped | Simulate → execute → poll, following their documented safe-first-write sequence (`packages/keeperhub/src/execute.ts`) |
| **Idempotency** | shipped | Per-attempt **and per-scope** keys, `hash(scope ‖ intentHash ‖ attempt)` (`packages/core/src/idempotency.ts`) |
| **Smart gas** | shipped | `gasLimitMultiplier` escalating across attempts (`packages/keeperhub/src/retry.ts`) |
| **MCP** | shipped | Five tools, verified live against Sepolia (`apps/mcp`) |
| **CLI** | documented only | `kh run logs` / `kh run status` appear in the runbook; nothing in the code depends on the CLI |
| **Workflow builder / Marketplace** | shipped | Listed as `assay-verify`, callable by any agent via `call_workflow`. Created through their MCP server, not the UI, so it is reproducible: `pnpm marketplace:publish` |
| **x402** | live, unsettled | The listing serves a real 402 challenge — `exact` scheme, 0.01 USDC on Base (`eip155:8453`), discoverable in the x402 Bazaar. No payment has settled yet: that needs a caller holding USDC on Base mainnet |
| **MPP** | **not built** | Tempo is configured as the alternate settlement chain, but no MPP path is implemented |

Note the distinction drawn for x402: the rail is real and verifiable — anyone
can `curl` the endpoint and get the 402 — but **no payment has settled**, and
saying "x402 integrated" without that qualifier would be the exact failure this
project exists to catch: a status line reporting success for something that did
not happen.

### The audit trail is the point

Assay treats KeeperHub's execution logs as a first-class input rather than as
logging. Most guardians gate *before* execution; Assay checks what the executor
*said afterwards*, against an independent read of the chain.

That is deliberate. It is the surface the rubric explicitly names.

---

## Protocol details we got right (and the ones that bit us)

These are undocumented or easy-to-miss behaviours discovered while building.
Each is handled in code and cited at the call site.

### `execute_contract_call` wants strings

`chainId`, `functionArgs` and `gasLimitMultiplier` must be **strings**. Passing
a JS number for `chainId` or a real array for `functionArgs` is accepted by the
type system and mishandled by the API.
([#1841](https://github.com/KeeperHub/keeperhub/issues/1841))

Handled in `toContractCallBody()` so no caller has to remember.

### Idempotency replay wedges retries — the big one

KeeperHub stores the response for an idempotency key and replays it for 24
hours. Correct for deduplication, **catastrophic for recovery**: if the stored
response was a failure, every "retry" under that key replays the failure without
resubmitting. The loop looks healthy and the transaction never lands.
([#1840](https://github.com/KeeperHub/keeperhub/issues/1840))

```ts
// Do not simplify this to keccak256(intentHash). That is the bug.
export function idempotencyKey(intentHash: Hex, attempt: number): string
```

Assay both **avoids** it (per-attempt keys) and **detects** it in others (the
`liveness` check → `IDEMPOTENCY_WEDGE`). Reproduced in `pnpm gauntlet`.

### Executions can have no transaction hash

Sponsored and 7702 executions can return no `txHash`, and are invisible to
nonce/balance/txlist. ([#1784](https://github.com/KeeperHub/keeperhub/issues/1784))

This is neither success nor error — it is **absence of evidence**, and Assay
reports it as `UNPROVEN` with reason `TX_HASH_ABSENT`. `ReceiptRegistry` accepts
a zero `txHash` so the receipt is still recorded rather than skipped.

### Simulation would-revert arrives as HTTP 400

A would-revert is a `400` with `wouldRevert: true`, not a `200` with a flag.
"This would revert" is information, so it is translated rather than allowed to
abort the run.

### Three different 409s

`idempotency_conflict` (client bug — use a new key) and
`idempotency_in_progress` (retry shortly) mean opposite things. The retry layer
distinguishes them; treating every 409 alike would either give up too early or
spin forever.

---

How Assay answers:

- **Tests** — 156 (121 TypeScript + 35 Solidity, six fuzz suites at 1,000 runs).
  See [TESTING.md](./TESTING.md).
- **Module boundaries** — `@assay/core` is vendor-neutral and provably cannot
  reach an execution provider; `@assay/keeperhub` is the only module permitted to
  submit. Enforced in CI, not asserted in prose.
- **Honest bug reports** — every protocol quirk above is cited at its call site
  and reproduced in a test. `UNPROVEN` exists specifically so the system can
  admit what it does not know.
- **Volume** — the runner is built to operate unattended for days behind
  execution and value caps.

---

## The independence claim, stated precisely

Assay's verdicts are only worth something if the data behind them did not come
from the party being verified.

1. **Reads never go through KeeperHub.** `@assay/observer` uses independent RPC
   endpoints plus Blockscout. `RPC_URLS` has no default that points at executor
   infrastructure, and `assertCanObserveIndependently` refuses to run without it.
2. **Quorum, not a single provider.** A reading corroborated by one endpoint is
   `UNPROVEN`, not `VERIFIED`.
3. **Writes only go through KeeperHub.** No wallet client, no
   `privateKeyToAccount`, anywhere outside the Foundry deploy script.
4. **Both are enforced by `pnpm lint:boundaries`**, which runs in CI.

If a future change made the reconciler read through KeeperHub, the build breaks.
That is the difference between a design principle and a comment.

---

## Reproducing our claims without trusting us

```bash
pnpm gauntlet          # four failure modes — no credentials
pnpm live:observer     # real Sepolia reads through 3 providers — no credentials
pnpm lint:boundaries   # the independence claim, mechanically
pnpm verify            # all of it plus 156 tests
```

And onchain, with nothing from this repo:

```bash
cast call $RECEIPT_REGISTRY "summary(address)(uint256,uint256,uint256,uint256)" $VERIFIER --rpc-url $RPC
```

A verifier whose tally is all `VERIFIED` and never `DIVERGENT` or `UNPROVEN` is
itself a finding. We made that number cheap to read on purpose.
