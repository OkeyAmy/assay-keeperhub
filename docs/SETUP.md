# Setup

Zero to a verified execution. Every command here was actually run while building
this; the outputs shown are real.

Defaults target **testnets**. Nothing in this guide moves real value.

---

## 0. Prerequisites

| Tool | Version used | Install |
|---|---|---|
| Node | 20.19.5 (≥20.9 required) | https://nodejs.org |
| pnpm | 10.20.0 | `npm i -g pnpm@10.20.0` |
| Foundry | forge 1.5.0-stable | `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |

```bash
node --version && pnpm --version && forge --version
```

---

## 1. Install

```bash
pnpm install
```

Installs all eight workspace packages. `forge-std` comes through pnpm rather
than `forge install`, because this repo is not a git submodule tree.

---

## 2. Verify the checkout before configuring anything

This needs **no credentials, no keys, no funds**:

```bash
pnpm verify
```

Runs, in order: module boundaries → 121 TypeScript tests → 35 Solidity tests →
the four-scenario failure gauntlet. Expected tail:

```
module boundaries intact:
      Tests  121 passed (121)
35 tests passed, 0 failed, 0 skipped (35 total tests)
all 4 scenarios caught
```

And to prove the independent read path talks to a real chain:

```bash
pnpm live:observer
```

```
chain 11155111
providers: 3, quorum: 2
chain tip        11376658n
agreeing         3/3
quorum reached   true
...
independent read path is live and corroborated
```

If both pass, the repository is healthy and the rest is configuration.

---

## 3. Configure

```bash
cp .env.example .env
```

`.env` is gitignored. It ships with working public Sepolia RPC endpoints and a
Blockscout URL already filled in. Four things still need you:

### 3a. KeeperHub account and API key — **required**

1. Sign up at https://app.keeperhub.com with an email address.
2. Verify the email. A Turnkey wallet is provisioned for your organisation
   automatically — no private key is ever exposed to you or to this code.
3. Copy the org wallet address (profile icon) into `ORG_WALLET_ADDRESS`.
4. Fund that wallet with Sepolia ETH from a faucet
   (https://sepoliafaucet.com or https://www.alchemy.com/faucets/ethereum-sepolia).
5. Create an organisation API key (prefix `kh_`) and set `KH_API_KEY`.

> **Known friction:** minting the key may trigger a step-up 2FA flow —
> KeeperHub issue [#1700](https://github.com/KeeperHub/keeperhub/issues/1700),
> filed by another agent building for this same hackathon. Expect it.

Free tier: 5,000 executions/month and $1 in gas credits, no card required.

### 3b. A deployer key — **required once, for step 4 only**

Generate a throwaway key and fund it with Sepolia ETH:

```bash
cast wallet new
```

This key deploys the two registries and is then never used again. **The agent
never signs with a private key** — every agent transaction goes through
KeeperHub. `pnpm lint:boundaries` enforces that.

### 3c. Strategy parameters — **required**

```env
STRATEGY_TOKEN=0x...        # an ERC-20 on Sepolia you hold
STRATEGY_RECIPIENT=0x...    # where the demo transfer goes
STRATEGY_AMOUNT=1000000     # base units, so 1 USDC at 6dp
STRATEGY_MIN_BALANCE=1000000
```

### 3d. LLM — **optional**

Any OpenAI-compatible endpoint. Leave blank and everything still works; the
model only *explains* verdicts and never decides one.

---

## 4. Deploy the registries

### Locally first (no funds, ~10 seconds)

```bash
anvil --silent &

cd contracts
export DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
export DEPLOY_RPC_URL=http://127.0.0.1:8545
pnpm run deploy
```

(That key is anvil's first well-known dev account — public, local-only, worthless.)

Real output from this repo:

```
chain id            31337
IntentRegistry      0x5FbDB2315678afecb367f032d93F642f64180aa3
ReceiptRegistry     0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
```

Verified working against that deployment:

```
isCommitted: true
chain head: 0x5a6dd46cf6e74a84ee1b5a52081e5ff242a6423ed68a965207b57062870aa183
total receipts: 1
summary (v/d/u/n): 1 0 0 0
```

…and appending a receipt that claims the wrong predecessor **reverts** with
`ChainBroken`, which is the tamper-evidence working.

### Then Sepolia

```bash
cd contracts
export DEPLOYER_PRIVATE_KEY=0x<your funded key>
export DEPLOY_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
pnpm run deploy        # add pnpm run deploy:verify with ETHERSCAN_API_KEY to verify source
```

Copy the two printed addresses into `.env`:

```env
INTENT_REGISTRY=0x...
RECEIPT_REGISTRY=0x...
```

---

## 5. Confirm the whole setup against the real services

```bash
pnpm --filter @assay/runner run doctor
```

It checks live endpoints, not string formats: RPC quorum against the real chain
tip, `GET /api/chains` on KeeperHub to confirm your chain is enabled for your
org, Blockscout reachability, and both registry addresses.

```
assay doctor

  ok    config parsed (chain 11155111, payments on 42431)
  ok    chain 11155111 is a testnet
  ok    3 independent RPC endpoints configured
  ok    RPC quorum reached at block 11376658
  ok    Blockscout reachable
  ok    KeeperHub reachable; chain 11155111 enabled (testnet)
  ok    IntentRegistry 0x...
  ok    ReceiptRegistry 0x...
  warn  LLM_API_KEY not set; verdict explanations disabled (verdicts still work)

all required checks passed
```

Fix anything marked `FAIL` before continuing. `warn` is safe to ignore.

---

## 6. Run it

```bash
pnpm --filter @assay/runner once     # one cycle: commit → execute → reconcile → receipt
pnpm --filter @assay/runner start    # continuous
pnpm --filter @assay/dashboard dev   # receipts explorer at localhost:3000
```

See [USAGE.md](./USAGE.md).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `RPC_URLS must list at least one endpoint` | No independent read path | Set `RPC_URLS`; a verdict read through the executor would be circular |
| `OBSERVER_QUORUM exceeds the number of configured RPC_URLS` | Quorum above provider count | Add providers or lower `OBSERVER_QUORUM` |
| `KH_API_KEY is required to execute` | Key missing | See 3a |
| `KeeperHub does not list chain N for this org` | Chain not enabled | Pick a chain from `GET /api/chains` where `isEnabled` |
| `Daily spending cap exceeded` (403) | Org spending cap | Raise it in KeeperHub settings |
| `WALLET_NOT_CONFIGURED` (422) | Turnkey wallet not provisioned | Verify your email in KeeperHub |
| `ChainBroken` on receipt write | Stale chain head | Expected and correct — the runner re-reads the head each cycle |
| `Module not found: './x.js'` in dashboard | Turbopack cannot map `.js`→`.ts` | Already handled: dashboard builds with `--webpack` |

---

## Failures found while bringing this up on real infrastructure

Every one of these was hit on a live Sepolia run against KeeperHub, and every
one is fixed in the code with a regression test. They are recorded because the
symptoms were all misleading — each looked like a different component's fault.

| Symptom | Actual cause | Fix |
|---|---|---|
| `ERR_PNPM_NOTHING_TO_DEPLOY` / `Unknown option: 'recursive'` | `deploy` and `doctor` are pnpm **built-in commands**, so `pnpm deploy` never reaches the script | Use `pnpm run deploy`, `pnpm run doctor` |
| Every value in `.env` read as empty | Nothing loaded `.env`; commands run from the package directory while the file is at the workspace root | `loadEnvFile()` walks upward from `cwd`; called from every entry point |
| `pnpm dev` started spending testnet funds | `turbo run dev` matched the runner's `dev` script as well as the dashboard's, silently starting the agent loop | Root `dev` is dashboard-only; the agent is `pnpm run agent` / `pnpm run agent:once` |
| Honest transfers reported `DIVERGENT (TARGET_MISMATCH)` | KeeperHub's sponsored/7702 path relays: top-level `to`/`from`/`input` belong to the relayer, and the intended call is an inner call | Conformance detects relaying and verifies via the target's own events plus declared balance bounds — never by waiving the check |
| `UNPROVEN (TX_NOT_FOUND_ONCHAIN)` on healthy runs | The chain was read immediately after broadcast, before independent providers had indexed the transaction | Bounded settle window; a transaction still unseen when it closes stays `UNPROVEN` |
| `UNPROVEN (TX_HASH_ABSENT)` on healthy runs | Two causes: the status endpoint can report `completed` a beat before publishing the hash, **and** the action was being rejected outright (below) | Bounded grace period for the hash, and the executor's own error is now printed |
| `Idempotency-Key was reused with a different request payload` | A cycle sends three different requests about one intent — commit, action, receipt — and all three derived their key from the intent hash alone | Keys are scoped: `idempotencyKey(hash, attempt, 'commit' \| 'action' \| 'receipt')` |
| Intermittent `fetch failed` to KeeperHub, and RPC quorum dropping | **Not KeeperHub.** Broken IPv6 on the host: both are dual-stack, and Node connects to the AAAA address and waits out the full timeout. `curl` hides this by racing both families | `enableDualStackFallback()` turns on Happy Eyeballs at every entry point |

The gas bound is worth calling out separately: a sponsored execution adds roughly
**80k gas** of smart-account wrapper overhead. A simulated bare ETH send
estimated 21,000 and actually used 102,119. `STRATEGY_MAX_GAS` sized for a plain
ERC-20 transfer will fail a legitimate run, so the default is 250,000.
