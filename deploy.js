#!/usr/bin/env node
/**
 * SignalStake — OP_NET Testnet Deployment Script
 *
 * Requirements:
 *   npm install opnet @btc-vision/transaction
 *
 * Usage:
 *   PRIVATE_KEY=<your_wif_key> node scripts/deploy.js
 *
 * The script:
 *   1. Reads the compiled WASM from build/SignalStake.wasm
 *   2. Connects to OP_NET testnet RPC
 *   3. Deploys the contract with constructor args
 *   4. Prints the deployed contract address
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    JSONRpcProvider,
    Wallet,
    DeploymentTransaction,
    Address,
    Network,
    networks,
    BytesWriter,
} from 'opnet';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────
const NETWORK           = networks.testnet;           // Bitcoin testnet
const RPC_URL           = 'https://testnet.opnet.org';
const WASM_PATH         = path.join(__dirname, '../build/SignalStake.wasm');
const REWARD_RATE       = 100n;                       // 100 sat-units reward per block
const POOL_NAME         = 'BTC/SIGNAL';
const MAX_SAT_TO_SPEND  = 100_000n;                   // 100k sat budget for deployment
const FEE_RATE          = 10;                         // sat/vbyte

// ── Load keys ─────────────────────────────────────────────
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
    console.error('\n❌  Set PRIVATE_KEY environment variable (WIF format)');
    process.exit(1);
}

async function deploy() {
    console.log('\n⬡  SignalStake — OP_NET Testnet Deployment');
    console.log('═'.repeat(50));

    // ── 1. Load WASM ─────────────────────────────────────
    if (!fs.existsSync(WASM_PATH)) {
        console.error(`❌  WASM not found at ${WASM_PATH}`);
        console.error('   Run: npm run build  (inside /contracts/)');
        process.exit(1);
    }
    const wasm = fs.readFileSync(WASM_PATH);
    console.log(`✓  WASM loaded: ${wasm.length} bytes`);

    // ── 2. Provider & Wallet ──────────────────────────────
    const provider = new JSONRpcProvider(RPC_URL, NETWORK);
    const wallet   = Wallet.fromWIF(PRIVATE_KEY, NETWORK);
    const address  = new Address(wallet.keypair.publicKey);
    console.log(`✓  Wallet: ${address.toString()}`);

    // Check balance
    try {
        const utxos = await provider.getUTXOs(wallet.p2tr);
        const totalSat = utxos.reduce((acc, u) => acc + BigInt(u.value), 0n);
        console.log(`✓  Balance: ${totalSat} satoshis`);
        if (totalSat < MAX_SAT_TO_SPEND) {
            console.warn(`⚠   Low balance. Get testnet BTC from a faucet first.`);
        }
    } catch (e) {
        console.warn(`⚠   Could not fetch balance: ${e.message}`);
    }

    // ── 3. Encode constructor args ────────────────────────
    // Constructor: rewardRatePerBlock (u64), poolName (string)
    const calldata = new BytesWriter();
    calldata.writeU64(REWARD_RATE);
    calldata.writeStringWithLength(POOL_NAME);

    console.log(`✓  Constructor args encoded`);
    console.log(`   Reward rate: ${REWARD_RATE} units/block`);
    console.log(`   Pool name:   ${POOL_NAME}`);

    // ── 4. Deploy ─────────────────────────────────────────
    console.log(`\n📡  Broadcasting deployment transaction...`);

    const deployTx = new DeploymentTransaction({
        signer: wallet.keypair,
        refundTo: wallet.p2tr,
        maximumAllowedSatToSpend: MAX_SAT_TO_SPEND,
        feeRate: FEE_RATE,
        network: NETWORK,
        bytecode: wasm,
        calldata: calldata.getBuffer(),
    });

    const result = await deployTx.deploy(provider);

    // ── 5. Results ────────────────────────────────────────
    if (!result || !result.contractAddress) {
        console.error('\n❌  Deployment failed. Check your balance and RPC.');
        console.error('   Result:', JSON.stringify(result, null, 2));
        process.exit(1);
    }

    console.log('\n╔' + '═'.repeat(50) + '╗');
    console.log('║  DEPLOYMENT SUCCESSFUL                           ║');
    console.log('╠' + '═'.repeat(50) + '╣');
    console.log(`║  Contract: ${result.contractAddress.padEnd(38)} ║`);
    console.log(`║  TXID:     ${result.txid.slice(0,38)}  ║`);
    console.log(`║  Network:  OP_NET Testnet                        ║`);
    console.log('╚' + '═'.repeat(50) + '╝');

    // Save deployment record
    const record = {
        contractAddress: result.contractAddress,
        txid:            result.txid,
        network:         'opnet_testnet',
        poolName:        POOL_NAME,
        rewardRate:      REWARD_RATE.toString(),
        deployedAt:      new Date().toISOString(),
        deployer:        address.toString(),
    };

    const outPath = path.join(__dirname, '../deployment.json');
    fs.writeFileSync(outPath, JSON.stringify(record, null, 2));
    console.log(`\n✓  Deployment saved to: ${outPath}`);
    console.log('\n📋  Next steps:');
    console.log(`   1. Copy the contract address above`);
    console.log(`   2. Paste it into frontend/src/config.ts`);
    console.log(`   3. Run: npm run dev  (in /frontend/)`);
}

deploy().catch(err => {
    console.error('\n❌  Fatal error:', err.message);
    process.exit(1);
});
