# ⬡ SignalStake — Real OP_NET DeFi
### Bitcoin DeFi Staking with Real OP_WALLET + AssemblyScript Contracts

---

## What Is Real In This Project

| Component | Status | Details |
|---|---|---|
| OP_WALLET connection | ✅ Real | `window.unisat.requestAccounts()` — opens wallet popup |
| BTC balance | ✅ Real | `window.unisat.getBalance()` — from your wallet |
| Transaction signing | ✅ Real | `window.unisat.signPsbt()` — user approves in wallet |
| Transaction broadcast | ✅ Real | `window.unisat.pushPsbt()` — sent to Bitcoin network |
| Smart contract | ✅ Real | AssemblyScript compiled to WASM, deployed on OP_NET |
| Contract reads | ✅ Real | OP_NET JSON-RPC → `getPoolInfo`, `getUserInfo` |
| Market prices | ✅ Real | CoinGecko API, polled every 10 seconds |
| Block height | ✅ Real | OP_NET RPC `eth_blockNumber` |
| PSBT building | ⚙️ Requires npm build | `opnet` SDK bundled by Vite (`npm run dev`) |

---

## Project Structure

```
SignalStake-Real/
├── contracts/
│   ├── src/
│   │   ├── index.ts                  ← WASM entry point
│   │   └── contracts/
│   │       └── SignalStake.ts        ← AssemblyScript staking contract
│   ├── scripts/
│   │   └── deploy.js                 ← OP_NET deployment script
│   ├── package.json
│   └── asconfig.json
│
├── frontend/
│   ├── index.html                    ← Dashboard (works standalone OR with npm)
│   ├── src/
│   │   ├── config.ts                 ← Contract address + RPC config
│   │   ├── wallet.ts                 ← OP_WALLET connection module
│   │   └── contract.ts               ← Full opnet SDK contract interactions
│   └── package.json
│
└── README.md
```

---

## Step 1 — Install OP_WALLET

OP_WALLET is the official Bitcoin wallet for OP_NET. It is a browser extension
forked from UniSat. It injects `window.unisat` into all browser pages.

1. Go to: **https://github.com/btc-vision/opwallet/releases**
2. Download the latest `.zip` file
3. Unzip to a folder
4. Open Chrome → `chrome://extensions/` → Enable **Developer Mode**
5. Click **Load unpacked** → select the unzipped folder
6. The OP_WALLET icon appears in your browser toolbar
7. Create or import a Bitcoin testnet wallet

---

## Step 2 — Build the Contract

```bash
cd contracts
npm install
npm run build
# Output: build/SignalStake.wasm
```

---

## Step 3 — Deploy to OP_NET Testnet

Get testnet BTC from a Bitcoin testnet faucet first.

```bash
# Set your wallet's WIF private key
export PRIVATE_KEY=<your_testnet_wif_key>

# Deploy
npm run deploy

# Output:
# ╔══════════════════════════════════════╗
# ║  DEPLOYMENT SUCCESSFUL               ║
# ║  Contract: bcrt1p...                 ║
# ║  TXID:     abc123...                 ║
# ╚══════════════════════════════════════╝
```

---

## Step 4 — Configure Frontend

Open `frontend/src/config.ts` and paste your deployed contract address:

```typescript
STAKING_CONTRACT: 'bcrt1p_YOUR_CONTRACT_ADDRESS_HERE',
```

Also update the same in `frontend/index.html` (line: `CONFIG.STAKING_CONTRACT`).

---

## Step 5 — Run Frontend

### Option A: Standalone (open index.html directly)
```bash
# Just open frontend/index.html in Chrome
# OP_WALLET connects, prices load, contract reads work
# Staking requires Option B for full PSBT building
```

### Option B: Full npm build (recommended for real staking)
```bash
cd frontend
npm install
npm run dev
# Opens: http://localhost:5173
# Full opnet SDK bundled — stake/withdraw/claim open OP_WALLET popup
```

---

## How Transactions Work

When you click **STAKE**, **WITHDRAW**, or **CLAIM**:

```
1. opnet SDK simulates the contract call
       ↓
2. SDK builds an unsigned Bitcoin PSBT
       ↓
3. window.unisat.signPsbt(psbt)
   → OP_WALLET popup opens
   → User reviews and approves
       ↓
4. window.unisat.pushPsbt(signedPsbt)
   → Signed transaction broadcast to Bitcoin network
       ↓
5. OP_NET nodes process the inscription
   → Contract state updated on-chain
```

---

## Contract Architecture

The `SignalStake.ts` contract uses:

- **AssemblyScript** compiled to **WASM** via `asc`
- **`@btc-vision/btc-runtime`** for storage, events, selectors
- **Storage pointers** (u16) for each state variable
- **Per-block reward accumulation** (similar to Compound/SushiSwap MasterChef)
- **Emergency pause** (owner-controlled)

### Key Methods

| Method | Type | Description |
|---|---|---|
| `stake(amount: u256)` | Write | Stake tokens, update reward debt |
| `withdraw(amount: u256)` | Write | Withdraw stake |
| `claimRewards()` | Write | Claim accumulated rewards |
| `exitPool()` | Write | Withdraw all + claim in one tx |
| `getPoolInfo()` | Read | TVL, reward rate, name, paused |
| `getUserInfo(addr)` | Read | Staked, earned, debt |
| `setRewardRate(rate)` | Admin | Update reward rate |
| `setPaused(flag)` | Admin | Emergency pause/unpause |

---

## Network Details

| Parameter | Value |
|---|---|
| Network | OP_NET Testnet |
| RPC | `https://testnet.opnet.org` |
| Explorer | `https://explorer.opnet.org` (if available) |
| Wallet | OP_WALLET (Chrome extension) |
| Contract language | AssemblyScript → WASM |
| Bitcoin testnet faucet | `https://testnet-faucet.mempool.co` |

---

## Market Data

Prices are fetched from CoinGecko's free API every 10 seconds:
```
GET https://api.coingecko.com/api/v3/simple/price
    ?ids=bitcoin,ethereum
    &vs_currencies=usd
    &include_24hr_change=true
```

No API key required for basic usage.

---

## License

MIT — SignalStake · Bitcoin DeFi on OP_NET
