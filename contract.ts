/**
 * contract.ts — Real OP_NET contract interactions for SignalStake
 *
 * Uses the `opnet` JavaScript SDK to:
 *   - Read pool/user state from the deployed contract
 *   - Build and broadcast stake / withdraw / claimRewards transactions
 *     which are signed by OP_WALLET (window.unisat)
 */

import {
    JSONRpcProvider,
    getContract,
    Address,
    Network,
    networks,
    BytesWriter,
    TransactionParameters,
    ContractRuntime,
    ICallResult,
} from 'opnet';
import { signPsbt, pushPsbt } from './wallet';
import { CONFIG } from './config';

// ── Provider ──────────────────────────────────────────────

let _provider: JSONRpcProvider | null = null;

function getProvider(): JSONRpcProvider {
    if (!_provider) {
        const net: Network =
            CONFIG.NETWORK === 'mainnet' ? networks.bitcoin : networks.testnet;
        _provider = new JSONRpcProvider(CONFIG.RPC_URL, net);
    }
    return _provider;
}

// ── ABI — maps selector names to their encoded selectors ──

const STAKING_ABI = [
    { name: 'stake',          inputs: ['u256'],          outputs: ['bool']       },
    { name: 'withdraw',       inputs: ['u256'],          outputs: ['bool']       },
    { name: 'claimRewards',   inputs: [],                outputs: ['u256']       },
    { name: 'exitPool',       inputs: [],                outputs: ['u256','u256']},
    { name: 'earned',         inputs: ['address'],       outputs: ['u256']       },
    { name: 'getPoolInfo',    inputs: [],                outputs: ['u256','u256','u256','u256','u256','string','bool'] },
    { name: 'getUserInfo',    inputs: ['address'],       outputs: ['u256','u256','u256'] },
    { name: 'setRewardRate',  inputs: ['u256'],          outputs: ['bool']       },
    { name: 'setPaused',      inputs: ['bool'],          outputs: ['bool']       },
] as const;

// ── Types ─────────────────────────────────────────────────

export interface PoolInfo {
    totalStaked:             bigint;
    rewardRatePerBlock:      bigint;
    totalRewardsDistributed: bigint;
    accRewardPerShare:       bigint;
    lastRewardBlock:         bigint;
    poolName:                string;
    paused:                  boolean;
}

export interface UserInfo {
    staked:   bigint;
    earned:   bigint;
    debtBase: bigint;
}

export interface TxResult {
    txid: string;
    success: boolean;
}

// ── Contract helpers ──────────────────────────────────────

function getStakingContract(contractAddress: string, callerAddress?: string) {
    const provider = getProvider();
    const net: Network =
        CONFIG.NETWORK === 'mainnet' ? networks.bitcoin : networks.testnet;

    const caller = callerAddress
        ? new Address(Buffer.from(callerAddress, 'hex'))
        : undefined;

    return getContract(
        contractAddress,
        STAKING_ABI,
        provider,
        net,
        caller
    );
}

// ── READ: getPoolInfo ─────────────────────────────────────

export async function fetchPoolInfo(contractAddress: string): Promise<PoolInfo> {
    const contract = getStakingContract(contractAddress);
    const result: ICallResult = await contract.getPoolInfo();

    const [
        totalStaked,
        rewardRatePerBlock,
        totalRewardsDistributed,
        accRewardPerShare,
        lastRewardBlock,
        poolName,
        paused,
    ] = result.properties as [bigint,bigint,bigint,bigint,bigint,string,boolean];

    return {
        totalStaked,
        rewardRatePerBlock,
        totalRewardsDistributed,
        accRewardPerShare,
        lastRewardBlock,
        poolName,
        paused,
    };
}

// ── READ: getUserInfo ─────────────────────────────────────

export async function fetchUserInfo(
    contractAddress: string,
    userAddress: string
): Promise<UserInfo> {
    const contract = getStakingContract(contractAddress);
    const userAddr = new Address(Buffer.from(userAddress, 'hex'));

    const result: ICallResult = await contract.getUserInfo(userAddr);
    const [staked, earned, debtBase] = result.properties as [bigint, bigint, bigint];

    return { staked, earned, debtBase };
}

// ── READ: earned ──────────────────────────────────────────

export async function fetchEarned(
    contractAddress: string,
    userAddress: string
): Promise<bigint> {
    const contract = getStakingContract(contractAddress);
    const userAddr = new Address(Buffer.from(userAddress, 'hex'));
    const result: ICallResult = await contract.earned(userAddr);
    return result.properties[0] as bigint;
}

// ── READ: Bitcoin balance via provider ────────────────────

export async function fetchBitcoinBalance(address: string): Promise<number> {
    try {
        const provider = getProvider();
        const utxos = await provider.getUTXOs(address);
        return utxos.reduce((acc: number, u: any) => acc + Number(u.value), 0);
    } catch {
        return 0;
    }
}

// ── WRITE helpers ─────────────────────────────────────────

/**
 * Build, simulate, sign (via OP_WALLET), and broadcast a
 * contract call transaction.
 *
 * Flow:
 *   1. Simulate the call with opnet SDK to build the PSBT
 *   2. Get the PSBT hex from the simulation result
 *   3. Pass PSBT to OP_WALLET for user signature (popup appears)
 *   4. Push the signed PSBT to the network
 */
async function sendContractTx(
    contractAddress: string,
    callerAddress: string,
    methodName: string,
    callFn: (contract: any) => Promise<ICallResult>,
    feeRate: number = 10,
    maxSat: bigint = 50_000n
): Promise<TxResult> {
    const net: Network =
        CONFIG.NETWORK === 'mainnet' ? networks.bitcoin : networks.testnet;

    const contract = getStakingContract(contractAddress, callerAddress);

    // Step 1: Simulate (generates the unsigned PSBT)
    const simulation: ICallResult = await callFn(contract);

    if (!simulation) {
        throw new Error('Contract simulation failed — no result returned');
    }

    // Step 2: Build transaction parameters
    const txParams: TransactionParameters = {
        refundTo:                 callerAddress,
        maximumAllowedSatToSpend: maxSat,
        feeRate,
        network:                  net,
    };

    // Step 3: Get the PSBT hex from the simulation
    const psbtHex: string = await simulation.buildTransaction(txParams);

    if (!psbtHex) {
        throw new Error('Failed to build PSBT from simulation');
    }

    // Step 4: Ask OP_WALLET to sign it — this opens the wallet popup
    const signedPsbt = await signPsbt(psbtHex, { autoFinalized: true });

    // Step 5: Broadcast
    const txid = await pushPsbt(signedPsbt);

    return { txid, success: true };
}

// ── WRITE: stake ──────────────────────────────────────────

export async function stakeTokens(
    contractAddress: string,
    callerAddress: string,
    amount: bigint,
    feeRate: number = 10
): Promise<TxResult> {
    return sendContractTx(
        contractAddress,
        callerAddress,
        'stake',
        (contract) => contract.stake(amount),
        feeRate
    );
}

// ── WRITE: withdraw ───────────────────────────────────────

export async function withdrawTokens(
    contractAddress: string,
    callerAddress: string,
    amount: bigint,
    feeRate: number = 10
): Promise<TxResult> {
    return sendContractTx(
        contractAddress,
        callerAddress,
        'withdraw',
        (contract) => contract.withdraw(amount),
        feeRate
    );
}

// ── WRITE: claimRewards ───────────────────────────────────

export async function claimRewards(
    contractAddress: string,
    callerAddress: string,
    feeRate: number = 10
): Promise<TxResult> {
    return sendContractTx(
        contractAddress,
        callerAddress,
        'claimRewards',
        (contract) => contract.claimRewards(),
        feeRate
    );
}

// ── WRITE: exitPool ───────────────────────────────────────

export async function exitPool(
    contractAddress: string,
    callerAddress: string,
    feeRate: number = 10
): Promise<TxResult> {
    return sendContractTx(
        contractAddress,
        callerAddress,
        'exitPool',
        (contract) => contract.exitPool(),
        feeRate
    );
}

// ── Network info ──────────────────────────────────────────

export async function fetchBlockNumber(): Promise<number> {
    try {
        const provider = getProvider();
        const info = await provider.getBlockNumber();
        return Number(info);
    } catch {
        return 0;
    }
}

export async function fetchFeeRates(): Promise<{ fast: number; avg: number; slow: number }> {
    try {
        const res = await fetch('https://mempool.space/testnet/api/v1/fees/recommended');
        const data = await res.json();
        return {
            fast: data.fastestFee ?? 20,
            avg:  data.halfHourFee ?? 10,
            slow: data.hourFee ?? 5,
        };
    } catch {
        return { fast: 20, avg: 10, slow: 5 };
    }
}
