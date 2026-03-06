import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    encodeSelector,
    Selector,
    OP_NET,
    StoredU256,
    StoredString,
    AddressMap,
} from '@btc-vision/btc-runtime/runtime';
import { u128, u256 } from 'as-bignum/assembly';

/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║         SIGNALSTAKE — AssemblyScript OP_NET Contract     ║
 * ║         Bitcoin DeFi Staking on OP_NET Testnet           ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * Pointers (u16 storage slots):
 *   1 = totalStaked
 *   2 = totalRewardsDistributed
 *   3 = rewardRatePerBlock  (reward tokens per block, scaled 1e8)
 *   4 = lastRewardBlock
 *   5 = accRewardPerShare   (scaled 1e12 for precision)
 *   6 = poolName
 *   7 = stakingTokenAddress
 *   8 = rewardTokenAddress
 *   9 = owner
 *   10 = paused
 *
 * Per-user sub-storage (pointer 20 + index):
 *   20 = stakedBalance  map<address, u256>
 *   21 = rewardDebt     map<address, u256>
 *   22 = pendingRewards map<address, u256>
 */

// ── Storage pointer constants ──────────────────────────────
const PTR_TOTAL_STAKED: u16            = 1;
const PTR_TOTAL_REWARDS: u16           = 2;
const PTR_REWARD_RATE: u16             = 3;
const PTR_LAST_REWARD_BLOCK: u16       = 4;
const PTR_ACC_REWARD_PER_SHARE: u16    = 5;
const PTR_POOL_NAME: u16               = 6;
const PTR_STAKING_TOKEN: u16           = 7;
const PTR_REWARD_TOKEN: u16            = 8;
const PTR_OWNER: u16                   = 9;
const PTR_PAUSED: u16                  = 10;
const PTR_STAKED_MAP: u16              = 20;
const PTR_DEBT_MAP: u16                = 21;
const PTR_PENDING_MAP: u16             = 22;

// ── Precision constants ────────────────────────────────────
const PRECISION: u256 = u256.fromU64(1_000_000_000_000); // 1e12
const MIN_STAKE: u256 = u256.fromU64(1000);  // min 1000 sat-units

// ── Event selectors ────────────────────────────────────────
const EVENT_STAKED: u8[]        = [0x01];
const EVENT_WITHDRAWN: u8[]     = [0x02];
const EVENT_CLAIMED: u8[]       = [0x03];
const EVENT_RATE_UPDATED: u8[]  = [0x04];

@final
export class SignalStake extends OP_NET {

    // ── Persistent storage ────────────────────────────────────
    private totalStaked: StoredU256;
    private totalRewardsDistributed: StoredU256;
    private rewardRatePerBlock: StoredU256;
    private lastRewardBlock: StoredU256;
    private accRewardPerShare: StoredU256;
    private poolName: StoredString;
    private paused: StoredU256;   // 0 = active, 1 = paused

    // ── Per-user maps ─────────────────────────────────────────
    private stakedBalance: AddressMap<StoredU256>;
    private rewardDebt: AddressMap<StoredU256>;
    private pendingRewards: AddressMap<StoredU256>;

    public constructor() {
        super();

        // Bind storage — runs every call, safe to call repeatedly
        this.totalStaked           = new StoredU256(PTR_TOTAL_STAKED, u256.Zero);
        this.totalRewardsDistributed = new StoredU256(PTR_TOTAL_REWARDS, u256.Zero);
        this.rewardRatePerBlock    = new StoredU256(PTR_REWARD_RATE, u256.Zero);
        this.lastRewardBlock       = new StoredU256(PTR_LAST_REWARD_BLOCK, u256.Zero);
        this.accRewardPerShare     = new StoredU256(PTR_ACC_REWARD_PER_SHARE, u256.Zero);
        this.poolName              = new StoredString(PTR_POOL_NAME);
        this.paused                = new StoredU256(PTR_PAUSED, u256.Zero);

        this.stakedBalance  = new AddressMap<StoredU256>(PTR_STAKED_MAP);
        this.rewardDebt     = new AddressMap<StoredU256>(PTR_DEBT_MAP);
        this.pendingRewards = new AddressMap<StoredU256>(PTR_PENDING_MAP);
    }

    // ─────────────────────────────────────────────────────────
    //  DEPLOYMENT  (runs once)
    // ─────────────────────────────────────────────────────────
    public override onDeployment(calldata: Calldata): void {
        // Read constructor args: rewardRatePerBlock (u64), poolName (string)
        const rate = calldata.readU64();
        const name = calldata.readStringWithLength();

        this.rewardRatePerBlock.set(u256.fromU64(rate));
        this.poolName.set(name);
        this.lastRewardBlock.set(Blockchain.blockNumber);

        // Store deployer as owner in slot PTR_OWNER
        const ownerWriter = new BytesWriter(32);
        ownerWriter.writeAddress(Blockchain.origin);
        Blockchain.setStorageAt(PTR_OWNER, ownerWriter.getBuffer());
    }

    // ─────────────────────────────────────────────────────────
    //  CALL DISPATCHER
    // ─────────────────────────────────────────────────────────
    public override execute(calldata: Calldata): BytesWriter {
        const selector: Selector = calldata.readSelector();

        if (selector === encodeSelector('stake'))            return this.stake(calldata);
        if (selector === encodeSelector('withdraw'))         return this.withdraw(calldata);
        if (selector === encodeSelector('claimRewards'))     return this.claimRewards();
        if (selector === encodeSelector('exitPool'))         return this.exitPool();
        if (selector === encodeSelector('earned'))           return this.viewEarned(calldata);
        if (selector === encodeSelector('getPoolInfo'))      return this.getPoolInfo();
        if (selector === encodeSelector('getUserInfo'))      return this.getUserInfo(calldata);
        if (selector === encodeSelector('setRewardRate'))    return this.setRewardRate(calldata);
        if (selector === encodeSelector('setPaused'))        return this.setPaused(calldata);

        throw new Error('SignalStake: unknown selector');
    }

    // ─────────────────────────────────────────────────────────
    //  INTERNAL: update reward accumulator
    // ─────────────────────────────────────────────────────────
    private updatePool(): void {
        const currentBlock = Blockchain.blockNumber;
        const lastBlock    = this.lastRewardBlock.get();

        if (currentBlock <= lastBlock) return;

        const supply = this.totalStaked.get();
        if (supply == u256.Zero) {
            this.lastRewardBlock.set(currentBlock);
            return;
        }

        const blocks = u256.sub(currentBlock, lastBlock);
        const reward = u256.mul(blocks, this.rewardRatePerBlock.get());

        // accRewardPerShare += reward * PRECISION / supply
        const delta = u256.div(u256.mul(reward, PRECISION), supply);
        this.accRewardPerShare.set(u256.add(this.accRewardPerShare.get(), delta));
        this.lastRewardBlock.set(currentBlock);
    }

    private _earned(user: Address): u256 {
        const staked  = this._getStaked(user);
        const debt    = this._getDebt(user);
        const pending = this._getPending(user);
        const acc     = this.accRewardPerShare.get();

        if (staked == u256.Zero) return pending;

        // accrued = staked * accRewardPerShare / PRECISION - debt + pending
        const accrued = u256.div(u256.mul(staked, acc), PRECISION);
        if (accrued >= debt) {
            return u256.add(u256.sub(accrued, debt), pending);
        }
        return pending;
    }

    private _getStaked(user: Address): u256 {
        const stored = this.stakedBalance.get(user);
        return stored ? stored.get() : u256.Zero;
    }

    private _getDebt(user: Address): u256 {
        const stored = this.rewardDebt.get(user);
        return stored ? stored.get() : u256.Zero;
    }

    private _getPending(user: Address): u256 {
        const stored = this.pendingRewards.get(user);
        return stored ? stored.get() : u256.Zero;
    }

    private _setStaked(user: Address, val: u256): void {
        let stored = this.stakedBalance.get(user);
        if (!stored) {
            stored = new StoredU256(PTR_STAKED_MAP, u256.Zero);
            this.stakedBalance.set(user, stored);
        }
        stored.set(val);
    }

    private _setDebt(user: Address, val: u256): void {
        let stored = this.rewardDebt.get(user);
        if (!stored) {
            stored = new StoredU256(PTR_DEBT_MAP, u256.Zero);
            this.rewardDebt.set(user, stored);
        }
        stored.set(val);
    }

    private _setPending(user: Address, val: u256): void {
        let stored = this.pendingRewards.get(user);
        if (!stored) {
            stored = new StoredU256(PTR_PENDING_MAP, u256.Zero);
            this.pendingRewards.set(user, stored);
        }
        stored.set(val);
    }

    private _updateUserReward(user: Address): void {
        const earnedNow = this._earned(user);
        this._setPending(user, earnedNow);
        // Update debt to current acc
        const staked = this._getStaked(user);
        const newDebt = u256.div(u256.mul(staked, this.accRewardPerShare.get()), PRECISION);
        this._setDebt(user, newDebt);
    }

    // ─────────────────────────────────────────────────────────
    //  STAKE
    // ─────────────────────────────────────────────────────────
    private stake(calldata: Calldata): BytesWriter {
        this._requireNotPaused();
        const amount = calldata.readU256();
        assert(amount >= MIN_STAKE, 'SignalStake: below minimum stake');

        const sender = Blockchain.sender;
        this.updatePool();
        this._updateUserReward(sender);

        const newStaked = u256.add(this._getStaked(sender), amount);
        this._setStaked(sender, newStaked);
        this.totalStaked.set(u256.add(this.totalStaked.get(), amount));

        // Recalculate debt after new stake
        const newDebt = u256.div(u256.mul(newStaked, this.accRewardPerShare.get()), PRECISION);
        this._setDebt(sender, newDebt);

        // Emit event
        const event = new BytesWriter(64);
        event.writeBytes(EVENT_STAKED);
        event.writeAddress(sender);
        event.writeU256(amount);
        Blockchain.emit(event.getBuffer());

        const response = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    // ─────────────────────────────────────────────────────────
    //  WITHDRAW
    // ─────────────────────────────────────────────────────────
    private withdraw(calldata: Calldata): BytesWriter {
        this._requireNotPaused();
        const amount = calldata.readU256();
        assert(amount > u256.Zero, 'SignalStake: zero amount');

        const sender  = Blockchain.sender;
        const staked  = this._getStaked(sender);
        assert(staked >= amount, 'SignalStake: insufficient staked balance');

        this.updatePool();
        this._updateUserReward(sender);

        const newStaked = u256.sub(staked, amount);
        this._setStaked(sender, newStaked);
        this.totalStaked.set(u256.sub(this.totalStaked.get(), amount));

        const newDebt = u256.div(u256.mul(newStaked, this.accRewardPerShare.get()), PRECISION);
        this._setDebt(sender, newDebt);

        const event = new BytesWriter(64);
        event.writeBytes(EVENT_WITHDRAWN);
        event.writeAddress(sender);
        event.writeU256(amount);
        Blockchain.emit(event.getBuffer());

        const response = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    // ─────────────────────────────────────────────────────────
    //  CLAIM REWARDS
    // ─────────────────────────────────────────────────────────
    private claimRewards(): BytesWriter {
        this._requireNotPaused();
        const sender = Blockchain.sender;

        this.updatePool();
        this._updateUserReward(sender);

        const reward = this._getPending(sender);
        assert(reward > u256.Zero, 'SignalStake: no rewards to claim');

        this._setPending(sender, u256.Zero);
        this.totalRewardsDistributed.set(
            u256.add(this.totalRewardsDistributed.get(), reward)
        );

        const event = new BytesWriter(64);
        event.writeBytes(EVENT_CLAIMED);
        event.writeAddress(sender);
        event.writeU256(reward);
        Blockchain.emit(event.getBuffer());

        const response = new BytesWriter(32);
        response.writeU256(reward);
        return response;
    }

    // ─────────────────────────────────────────────────────────
    //  EXIT POOL (withdraw all + claim)
    // ─────────────────────────────────────────────────────────
    private exitPool(): BytesWriter {
        this._requireNotPaused();
        const sender = Blockchain.sender;

        this.updatePool();
        this._updateUserReward(sender);

        const staked  = this._getStaked(sender);
        const pending = this._getPending(sender);

        if (staked > u256.Zero) {
            this._setStaked(sender, u256.Zero);
            this._setDebt(sender, u256.Zero);
            this.totalStaked.set(u256.sub(this.totalStaked.get(), staked));
        }

        if (pending > u256.Zero) {
            this._setPending(sender, u256.Zero);
            this.totalRewardsDistributed.set(
                u256.add(this.totalRewardsDistributed.get(), pending)
            );
        }

        const response = new BytesWriter(64);
        response.writeU256(staked);
        response.writeU256(pending);
        return response;
    }

    // ─────────────────────────────────────────────────────────
    //  VIEW: earned
    // ─────────────────────────────────────────────────────────
    private viewEarned(calldata: Calldata): BytesWriter {
        const user = calldata.readAddress();
        this.updatePool();
        const amount = this._earned(user);
        const response = new BytesWriter(32);
        response.writeU256(amount);
        return response;
    }

    // ─────────────────────────────────────────────────────────
    //  VIEW: getPoolInfo
    // ─────────────────────────────────────────────────────────
    private getPoolInfo(): BytesWriter {
        const response = new BytesWriter(256);
        response.writeU256(this.totalStaked.get());
        response.writeU256(this.rewardRatePerBlock.get());
        response.writeU256(this.totalRewardsDistributed.get());
        response.writeU256(this.accRewardPerShare.get());
        response.writeU256(this.lastRewardBlock.get());
        response.writeStringWithLength(this.poolName.get());
        response.writeBoolean(this.paused.get() != u256.Zero);
        return response;
    }

    // ─────────────────────────────────────────────────────────
    //  VIEW: getUserInfo
    // ─────────────────────────────────────────────────────────
    private getUserInfo(calldata: Calldata): BytesWriter {
        const user = calldata.readAddress();
        this.updatePool();
        const response = new BytesWriter(128);
        response.writeU256(this._getStaked(user));
        response.writeU256(this._earned(user));
        response.writeU256(this._getDebt(user));
        return response;
    }

    // ─────────────────────────────────────────────────────────
    //  ADMIN: setRewardRate
    // ─────────────────────────────────────────────────────────
    private setRewardRate(calldata: Calldata): BytesWriter {
        this._requireOwner();
        this.updatePool();
        const newRate = calldata.readU256();
        this.rewardRatePerBlock.set(newRate);

        const event = new BytesWriter(32);
        event.writeBytes(EVENT_RATE_UPDATED);
        event.writeU256(newRate);
        Blockchain.emit(event.getBuffer());

        const response = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    // ─────────────────────────────────────────────────────────
    //  ADMIN: setPaused
    // ─────────────────────────────────────────────────────────
    private setPaused(calldata: Calldata): BytesWriter {
        this._requireOwner();
        const flag = calldata.readBoolean();
        this.paused.set(flag ? u256.fromU64(1) : u256.Zero);
        const response = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    // ─────────────────────────────────────────────────────────
    //  GUARDS
    // ─────────────────────────────────────────────────────────
    private _requireNotPaused(): void {
        assert(this.paused.get() == u256.Zero, 'SignalStake: contract is paused');
    }

    private _requireOwner(): void {
        const ownerBuf = Blockchain.getStorageAt(PTR_OWNER);
        const ownerAddr = Address.fromBytes(ownerBuf);
        assert(
            Blockchain.origin.equals(ownerAddr),
            'SignalStake: caller is not owner'
        );
    }
}
