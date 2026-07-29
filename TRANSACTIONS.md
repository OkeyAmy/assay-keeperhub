# Transactions

Every agent transaction below was executed by **KeeperHub's Direct Execution
API** on **Ethereum Sepolia (11155111)**. No transaction here was signed by a
private key held in this codebase — `pnpm lint:boundaries` fails the build if
anything outside `@assay/keeperhub` can submit one.

The only exception is the one-time registry deployment, which is setup rather
than agent action, and is listed separately at the bottom.

---

## Deployed contracts

| Contract | Address |
|---|---|
| IntentRegistry | [`0x75Fd7a39c85E34EFaD09EbCE39dc0d0e4AE4E561`](https://sepolia.etherscan.io/address/0x75Fd7a39c85E34EFaD09EbCE39dc0d0e4AE4E561) |
| ReceiptRegistry | [`0x3a5D1FC35736Bdb1656bb35Ce1503B62FAa5d4cA`](https://sepolia.etherscan.io/address/0x3a5D1FC35736Bdb1656bb35Ce1503B62FAa5d4cA) |
| Verifier (KeeperHub org wallet) | [`0x39D438c6C41168DB49DcAe73Fc0D8a6D5D48Aa57`](https://sepolia.etherscan.io/address/0x39D438c6C41168DB49DcAe73Fc0D8a6D5D48Aa57) |

## Current onchain tally

Read it yourself — nothing from this repository is involved:

```bash
cast call 0x3a5D1FC35736Bdb1656bb35Ce1503B62FAa5d4cA \
  "summary(address)(uint256,uint256,uint256,uint256)" \
  0x39D438c6C41168DB49DcAe73Fc0D8a6D5D48Aa57 \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

| Verdict | Count |
|---|---:|
| VERIFIED | 3 |
| DIVERGENT | 6 |
| UNPROVEN | 4 |
| NOT_EXECUTED | 0 |
| **Total receipts (all verifiers)** | **13** |

Chain head: `0xd0d442a24788b6d6e4b9eb3cc5e16cb1de6c742a267a0ca37a27a1a03bf664a0`

**This tally is deliberately not all `VERIFIED`.** The `DIVERGENT` and
`UNPROVEN` entries are real findings from bringing the system up against live
infrastructure, not seeded demo data. Each cause is documented and fixed in
[docs/SETUP.md](./docs/SETUP.md#failures-found-while-bringing-this-up-on-real-infrastructure).
A verifier whose record is spotless is a verifier that is not looking, so the
count is cheap to read on purpose.

---

## Representative transactions

Each cycle produces **three** KeeperHub-executed transactions: the intent
commitment, the value-moving action, and the verification receipt.

| # | What | Transaction |
|---|---|---|
| 1 | Value transfer, verdict `VERIFIED` | [`0x1315184c…52756f`](https://sepolia.etherscan.io/tx/0x1315184c049a993a768a42ba40294a617396a2ee67d12c09d3fce1a0a852756f) |
| 2 | Value transfer, verdict `VERIFIED` | [`0x9ddc419a…932093`](https://sepolia.etherscan.io/tx/0x9ddc419a917281fbd64b3434722b54b4d0a49ab4c55095fefe5822ad35932093) |
| 3 | Value transfer, verdict `DIVERGENT` (pre-fix, relayed-execution bug) | [`0x287d206e…a6dedd`](https://sepolia.etherscan.io/tx/0x287d206ef1504044502f46fb763e270fd7d8d2d8218e8a06c99adf298da6dedd) |
| 4 | Native transfer funding the deployer, `sponsored: true` | [`0xa21e9631…02ad26`](https://sepolia.etherscan.io/tx/0xa21e9631e74bb3c4efe41fd9f0e0f176c290aeca602b25326e9321544d02ad26) |
| 5 | Contract call, direct API probe | [`0x5f5276a5…9ebc42`](https://sepolia.etherscan.io/tx/0x5f5276a5b9b4ca8dc980e780580778f659ed5d3e693ede6a368999d88b9ebc42) |

To enumerate every receipt with its intent hash, transaction and block, walk the
registry directly:

```bash
cast call 0x3a5D1FC35736Bdb1656bb35Ce1503B62FAa5d4cA \
  "chainFrom(bytes32,uint256)((bytes32,bytes32,uint8,bytes32,bytes32,uint64,address,uint64)[])" \
  0xd0d442a24788b6d6e4b9eb3cc5e16cb1de6c742a267a0ca37a27a1a03bf664a0 20 \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

---

## Marketplace listing

Published to KeeperHub's marketplace as **`assay-verify`**, created and listed
through their MCP server rather than the UI so it is reproducible from source:
`pnpm marketplace:publish` (`scripts/marketplace/publish.ts`).

Anyone can confirm the x402 rail is live, with no credentials:

```bash
curl -s -X POST https://app.keeperhub.com/api/mcp/workflows/assay-verify/call \
  -H 'content-type: application/json' -d '{}'
```

```json
{ "x402Version": 2,
  "accepts": [{ "scheme": "exact",
                "network": "eip155:8453",
                "asset":   "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                "amount":  "10000",
                "payTo":   "0x39d438c6c41168db49dcae73fc0d8a6d5d48aa57" }],
  "extensions": { "bazaar": { "discoverable": true } } }
```

0.01 USDC on Base mainnet, discoverable in the x402 Bazaar. **No payment has
settled yet** — that requires a caller holding USDC on Base.

A successful authenticated call (execution `erz8i6biue61wz3z13p77`) returned this
deployment's real onchain record: `verified 3, divergent 6, unproven 4`.

KeeperHub also auto-registered this deployment on the ERC-8004 ReputationRegistry
as agent [`31875`](https://8004scan.io/agents/ethereum/31875).

---

## Observed executor behaviour

Two things worth recording, both measured rather than assumed:

**Executions are relayed.** KeeperHub's sponsored path routes through
`0x5aF5194B4b0909eB978e3Cf1e25333852277f07D`, so the transaction's top-level
`to`, `from` and `input` belong to the relayer and the intended call appears as
an inner call. Their status endpoint confirms this as `topLevelTo`. A verifier
comparing top-level fields against a committed intent will mark every honest
sponsored execution as divergent — which is exactly what happened here before it
was fixed.

**Sponsorship costs roughly 80k gas.** A bare ETH send simulated at 21,000 gas
and used 102,119. An ERC-20 transfer through the same path uses ~67k–85k. Gas
bounds sized for a direct call will fail legitimate runs.

---

## Deployment (not agent activity)

The registries were deployed with Foundry using a throwaway key, because a
contract cannot deploy itself. This is the only private key anywhere in the
project, it deployed twice, and it never signs an agent transaction.
