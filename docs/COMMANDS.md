# Command reference

Every command in the project, with what it actually does. Commands marked
**verified** were run during development and their real output is reproduced.

---

## Verification (no credentials needed)

| Command | What it does |
|---|---|
| `pnpm verify` | **verified** — boundaries + 156 tests + gauntlet, in one gate |
| `pnpm test` | **verified** — 121 TypeScript tests (Vitest) |
| `pnpm test:contracts` | **verified** — 35 Solidity tests (Foundry) |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm lint:boundaries` | **verified** — enforces module independence |
| `pnpm gauntlet` | **verified** — four failure scenarios |
| `pnpm live:observer` | **verified** — reads a real Sepolia transaction through 3 providers |
| `pnpm typecheck` | **verified** — all packages |

### `pnpm verify`

```
module boundaries intact:
      Tests  121 passed (121)
35 tests passed, 0 failed, 0 skipped (35 total tests)
all 4 scenarios caught
```

### `pnpm lint:boundaries`

```
module boundaries intact:
  - core and observer are independent of any execution provider
  - transaction submission is confined to @assay/keeperhub
```

Fails the build if `@assay/core` or `@assay/observer` ever import an execution
provider, or if anything outside `@assay/keeperhub` calls `writeContract`,
`sendTransaction`, `createWalletClient` or `privateKeyToAccount`.

### `pnpm gauntlet`

```
1. Calldata divergence            assay: DIVERGENT (CALLDATA_MISMATCH)          caught
2. Reported success, onchain revert  assay: DIVERGENT (REVERTED_BUT_REPORTED_SUCCESS)  caught
3. Idempotency wedge (#1840)      assay: DIVERGENT (IDEMPOTENCY_WEDGE)          caught
4. Independent read path down     assay: UNPROVEN  (OBSERVER_UNAVAILABLE)       caught

all 4 scenarios caught
```

### `pnpm live:observer`

```
chain 11155111
providers: 3, quorum: 2

chain tip        11376658n
agreeing         3/3
quorum reached   true

observing 0x79a16022343973053191fbf83e4950a80d72245751a4286c0bd0cad85dbd816c
  from block 11376660

available        true
agreeing         3/2 required
to               0xedf4b1c6af6520bb76826525adef7e0e09af2c8d
status           success
gas used         174744
logs             1

independent read path is live and corroborated
```

---

## Running the agent

| Command | What it does |
|---|---|
| `pnpm run doctor` | **verified** — validate config against the live KeeperHub and RPC endpoints |
| `pnpm run agent:once` | **verified** — one cycle: commit → execute → reconcile → receipt |
| `pnpm run agent` | Run continuously until SIGINT |
| `pnpm --filter @assay/runner run watch` | As `agent`, with reload on change |

> `deploy` and `doctor` are pnpm built-in commands. `pnpm doctor` runs pnpm's
> own diagnostic, not this one — always use `pnpm run doctor`. The root
> `agent` / `agent:once` aliases exist so the agent is never started by accident.

`pnpm dev` runs **only** the dashboard. The agent moves real testnet value, so
it is never part of a generic dev command.

`doctor` checks live services, not string formats. Run it before `once`.

---

## Contracts

| Command | What it does |
|---|---|
| `pnpm --filter @assay/contracts build` | `forge build` |
| `pnpm --filter @assay/contracts test` | **verified** — 35 tests, verbose |
| `pnpm --filter @assay/contracts test:gas` | Gas report |
| `pnpm --filter @assay/contracts fmt` | `forge fmt` |
| `pnpm --filter @assay/contracts run deploy` | **verified** — deploy both registries |
| `pnpm --filter @assay/contracts run deploy:verify` | Deploy and verify source on the explorer |

Deploy needs `DEPLOYER_PRIVATE_KEY` and `DEPLOY_RPC_URL`. **This is the only
place in the project a raw private key is used**, and it is setup rather than
agent action.

### Verified local deployment

```bash
anvil --silent &
cd contracts
export DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
export DEPLOY_RPC_URL=http://127.0.0.1:8545
pnpm run deploy
```

```
chain id            31337
IntentRegistry      0x5FbDB2315678afecb367f032d93F642f64180aa3
ReceiptRegistry     0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
```

### Verified contract exercise

```bash
IH=$(cast keccak "live-intent-1")
cast send $IR "commit(bytes32,uint256,uint64)" $IH 31337 $DEADLINE --private-key $KEY --rpc-url $RPC
cast call $IR "isCommitted(bytes32)(bool)" $IH --rpc-url $RPC
# true

cast send $RR "write(bytes32,bytes32,uint8,bytes32,bytes32,uint64)" $IH $TX 1 $R $ZERO $NOW --private-key $KEY --rpc-url $RPC
cast call $RR "head(address)(bytes32)" $ADDR --rpc-url $RPC
# 0x5a6dd46cf6e74a84ee1b5a52081e5ff242a6423ed68a965207b57062870aa183
cast call $RR "totalReceipts()(uint256)" --rpc-url $RPC
# 1
cast call $RR "summary(address)(uint256,uint256,uint256,uint256)" $ADDR --rpc-url $RPC
# 1 0 0 0     (verified / divergent / unproven / not-executed)
```

Appending a receipt that claims the wrong predecessor **reverts with
`ChainBroken`** — the tamper-evidence working as designed.

---

## Dashboard

| Command | What it does |
|---|---|
| `pnpm --filter @assay/dashboard dev` | **verified** — explorer on http://localhost:3000 |
| `pnpm --filter @assay/dashboard build` | **verified** — production build |
| `pnpm --filter @assay/dashboard start` | Serve the production build |

Both use `--webpack`: the workspace packages ship TypeScript with NodeNext
`./x.js` specifiers, and Turbopack will not map those to `.ts`.

---

## MCP server

| Command | What it does |
|---|---|
| `pnpm --filter @assay/mcp start` | Run the MCP server over stdio |

Register with Claude Code:

```bash
claude mcp add assay -- pnpm --filter @assay/mcp start
```

Tools: `assay_verify`, `assay_hash_intent`, `assay_check_commitment`,
`assay_receipts`, `assay_status`.

---

## KeeperHub CLI

Not required, but a named judging surface and useful for cross-checking what
Assay reports against what KeeperHub reports:

```bash
brew install keeperhub/tap/kh
kh auth login                  # or export KH_API_KEY
kh workflow list
kh run status <run-id>
kh run logs <run-id>
```

---

## Cross-language hash check

Confirms `ReceiptRegistry._hashReceipt` and `@assay/core`'s `hashReceipt` agree
byte-for-byte. If they drift, a chain built offchain is rejected onchain.

```bash
cast keccak $(cast abi-encode "f(bytes32,bytes32,uint8,bytes32,bytes32,uint64)" \
  $(cast keccak "i") $(cast keccak "t") 1 $(cast keccak "ALL_CHECKS_PASSED") \
  0x0000000000000000000000000000000000000000000000000000000000000000 1700000000)
# 0x82469deff204bfdd4c3c2dfd76f41a6a13e8ead9fecba25923cf8aaf9075fa17
```

That value is pinned as a golden vector in
`packages/core/test/receipt.test.ts`, so CI catches any divergence.

---

## Housekeeping

| Command | What it does |
|---|---|
| `pnpm build` | Turbo build across the workspace |
| `pnpm clean` | Remove build output |
| `pnpm format` / `pnpm format:check` | Prettier, including Solidity |
