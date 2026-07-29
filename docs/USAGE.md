# Using Assay

Three ways to use it: **run the agent**, **call it from your own agent over
MCP**, or **read the receipts**.

Setup first: [SETUP.md](./SETUP.md).

---

## 1. Run the agent

### One cycle

```bash
pnpm --filter @assay/runner once
```

Produces **three KeeperHub-executed transactions**:

```
plan: transfer 1000000 of 0x1c7D…7238 to 0x742d…0bEb

  verdict: VERIFIED (ALL_CHECKS_PASSED)
    pass  existence
    pass  conformance
    pass  effect
    pass  liveness
    tx: https://sepolia.etherscan.io/tx/0x…
    receipt: 0x5a6dd46cf6e74a84ee1b5a52081e5ff242a6423ed68a965207b57062870aa183
```

What happened, in order:

1. **Simulate.** KeeperHub's documented safe-first-write sequence — the body
   simulated is the body broadcast.
2. **Commit** `hash(intent)` onchain. This is what makes the rest a guarantee
   rather than a claim; the promise is timestamped before the action.
3. **Execute** the value-moving transaction through the Direct Execution API,
   with a per-attempt idempotency key and escalating gas.
4. **Reconcile.** Pull KeeperHub's audit trail; read the chain through
   independent providers; run the four checks.
5. **Receipt.** Write the verdict onchain, hash-chained to the previous one —
   whatever the verdict was.

### Continuously

```bash
pnpm --filter @assay/runner start
```

Ticks every `TICK_INTERVAL_MS`. A failed tick is logged and the loop continues;
one RPC blip is not a reason to stop verifying. `SIGINT` finishes the current
cycle and stops cleanly.

Guards, all enforced before the commitment:

| Guard | Env |
|---|---|
| Executions per day | `MAX_EXECUTIONS_PER_DAY` |
| Value per transaction | `MAX_VALUE_PER_TX` |
| Intent lifetime | `INTENT_TTL_SECONDS` |
| Retry attempts | `MAX_ATTEMPTS` |
| Stop everything | `KILL_SWITCH=true` |

---

## 2. Reading the verdicts

Four outcomes. The distinction between the last two is the whole point.

| Verdict | Meaning | What to do |
|---|---|---|
| `VERIFIED` | Committed intent, executor report and chain state all agree | Nothing |
| `DIVERGENT` | Proven mismatch between what was promised and what happened | **Investigate.** Real bug or real drift |
| `UNPROVEN` | Insufficient independent evidence to conclude anything | Fix observability, then re-verify |
| `NOT_EXECUTED` | Never submitted — simulation rejected, expired, or cancelled | Usually expected |

**`UNPROVEN` is not a soft `VERIFIED`.** It means the verifier could not tell.
Nothing in this system upgrades one to the other.

### Reason codes worth recognising

| Reason | What it means |
|---|---|
| `CALLDATA_MISMATCH` | Executed transaction differs from the commitment — template binding, decimal error, wrong recipient |
| `REVERTED_BUT_REPORTED_SUCCESS` | Executor said success; the chain reverted |
| `NO_STATE_CHANGE_ON_SUCCESS` | Succeeded and did nothing |
| `BALANCE_DELTA_OUT_OF_BOUNDS` | Moved an amount outside the declared range |
| `IDEMPOTENCY_WEDGE` | Retries replayed a cached failure and never resubmitted ([#1840](https://github.com/KeeperHub/keeperhub/issues/1840)) |
| `TX_HASH_ABSENT` | Executor reported no transaction hash ([#1784](https://github.com/KeeperHub/keeperhub/issues/1784)) |
| `OBSERVER_QUORUM_FAILED` | Too few independent providers agreed |

---

## 3. Call Assay from your own agent (MCP)

Assay is an MCP server, so any agent can buy verification without cloning this
repo.

```bash
claude mcp add assay -- pnpm --filter @assay/mcp start
```

### `assay_verify`

The headline tool. Verify **anyone's** KeeperHub execution — you need not be the
party that executed it.

```json
{
  "executionId": "direct_123",
  "intent": {
    "chainId": 11155111,
    "target": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    "selector": "0xa9059cbb",
    "args": "0x000…",
    "value": "0",
    "bounds": {
      "balanceDeltas": [
        { "token": "0x1c7D…", "account": "0xAgent…", "min": "-1000000", "max": "-1000000" }
      ],
      "requiredTopics": ["0xddf252ad…"],
      "maxGasUsed": "100000"
    },
    "deadline": "1800000000",
    "nonce": "1",
    "policyHash": "0x11…"
  }
}
```

Returns the verdict, the per-check breakdown, an explorer link, and — crucially —
how many independent providers backed the conclusion:

```json
{
  "verdict": "DIVERGENT",
  "reason": "CALLDATA_MISMATCH",
  "detail": "executed calldata does not match the committed intent",
  "checks": [ … ],
  "independentProviders": 3,
  "quorumRequired": 2
}
```

### The other tools

| Tool | Use |
|---|---|
| `assay_hash_intent` | Canonical intent hash, for committing or comparing |
| `assay_check_commitment` | Was this intent committed before execution? |
| `assay_receipts` | A verifier's verdict tally and chain head |
| `assay_status` | This deployment's chain, providers and registries |

`assay_status` is the one to call first if you are evaluating whether to trust a
given Assay deployment: it reports how many **independent** providers back the
read path, which is what makes a verdict non-circular.

---

## 4. The receipts explorer

```bash
pnpm --filter @assay/dashboard dev
```

http://localhost:3000 — verdict tallies, every receipt with its intent hash, tx
link, and block. It reads the registry **directly from chain through the same
independent RPC quorum**, with no indexer and no database: tamper-evidence is
worthless if checking it requires trusting a server.

---

## 5. Verifying Assay itself

A verifier you cannot check is just another black box.

```bash
pnpm lint:boundaries   # the reconciler structurally cannot read through KeeperHub
pnpm gauntlet          # four failure modes, no credentials required
pnpm live:observer     # the read path against a real chain, no credentials required
pnpm verify            # all of the above plus 152 tests
```

Onchain, anyone can walk a verifier's receipt chain without this codebase:

```bash
cast call $RECEIPT_REGISTRY "summary(address)(uint256,uint256,uint256,uint256)" $VERIFIER --rpc-url $RPC
# verified divergent unproven notExecuted
```

A verifier that has only ever reported `VERIFIED` is itself a finding.

---

## Extending

### A new strategy

Implement `plan(): Promise<ActionPlan | null>` — see
`packages/agent/src/strategies/treasury.ts`. The only real requirement is that
the intent declares **falsifiable** effects: exact balance bounds, required
event topics, or both. `PolicyGuard` rejects an intent that declares no
observable effect, because verifying it would prove nothing.

### A different chain

Set `CHAIN_ID`. Add the chain to `packages/config/src/chains.ts` if viem does
not ship it. Note that KeeperHub's agentic wallet signs only on Base (8453),
Tempo (4217) and Tempo testnet (42431) — which is why the testnet payment leg
uses Tempo rather than Base Sepolia.

### No model to swap

There is deliberately no LLM in this project. `reconcile()` is deterministic, so
a verdict is reproducible by anyone holding the same three inputs. Adding a
model could only ever soften that.
