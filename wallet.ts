/**
 * wallet.ts — Real OP_WALLET (window.unisat) connection
 *
 * OP_WALLET is forked from UniSat and exposes the same
 * window.unisat API injected into the browser by the extension.
 *
 * Install OP_WALLET:
 *   https://github.com/btc-vision/opwallet/releases
 */

// ── Types ─────────────────────────────────────────────────

export interface WalletState {
    connected: boolean;
    address: string | null;
    publicKey: string | null;
    balance: number;         // in satoshis
    network: string | null;
}

export type WalletEvent = 'accountsChanged' | 'networkChanged' | 'disconnect';

// ── Detect OP_WALLET ──────────────────────────────────────

function getProvider(): any {
    // OP_WALLET injects window.unisat (same API as UniSat)
    if (typeof window !== 'undefined' && (window as any).unisat) {
        return (window as any).unisat;
    }
    return null;
}

export function isWalletInstalled(): boolean {
    return getProvider() !== null;
}

// ── Connect ───────────────────────────────────────────────

/**
 * Prompts the user to connect OP_WALLET.
 * Opens the wallet extension popup.
 * Returns the connected address or throws.
 */
export async function connectWallet(): Promise<WalletState> {
    const provider = getProvider();
    if (!provider) {
        throw new Error(
            'OP_WALLET not found. Install it from:\n' +
            'https://github.com/btc-vision/opwallet/releases'
        );
    }

    // requestAccounts opens the wallet popup for user approval
    const accounts: string[] = await provider.requestAccounts();
    if (!accounts || accounts.length === 0) {
        throw new Error('No accounts returned. User may have rejected the request.');
    }

    const address   = accounts[0];
    const publicKey = await provider.getPublicKey();
    const network   = await provider.getNetwork();
    const balanceInfo = await provider.getBalance();

    return {
        connected: true,
        address,
        publicKey,
        balance:  balanceInfo?.confirmed ?? 0,
        network,
    };
}

// ── Disconnect ────────────────────────────────────────────

export async function disconnectWallet(): Promise<void> {
    // OP_WALLET/UniSat does not have an explicit disconnect method.
    // The dapp simply forgets the session. The user can revoke
    // access from the extension itself.
}

// ── Get current state (no popup) ─────────────────────────

export async function getWalletState(): Promise<WalletState | null> {
    const provider = getProvider();
    if (!provider) return null;

    try {
        const accounts = await provider.getAccounts();
        if (!accounts || accounts.length === 0) {
            return { connected: false, address: null, publicKey: null, balance: 0, network: null };
        }
        const address   = accounts[0];
        const publicKey = await provider.getPublicKey();
        const network   = await provider.getNetwork();
        const balanceInfo = await provider.getBalance();

        return {
            connected: true,
            address,
            publicKey,
            balance: balanceInfo?.confirmed ?? 0,
            network,
        };
    } catch {
        return { connected: false, address: null, publicKey: null, balance: 0, network: null };
    }
}

// ── Sign a message (for identity verification) ───────────

export async function signMessage(message: string): Promise<string> {
    const provider = getProvider();
    if (!provider) throw new Error('Wallet not connected');
    return await provider.signMessage(message, 'bip322-simple');
}

// ── Sign a PSBT ───────────────────────────────────────────

/**
 * Signs a PSBT hex string with the connected wallet.
 * Used internally by the contract interaction layer.
 */
export async function signPsbt(
    psbtHex: string,
    options?: {
        autoFinalized?: boolean;
        toSignInputs?: { index: number; address: string }[];
    }
): Promise<string> {
    const provider = getProvider();
    if (!provider) throw new Error('Wallet not connected');

    const signed: string = await provider.signPsbt(psbtHex, options ?? {
        autoFinalized: true,
    });
    return signed;
}

// ── Push a signed PSBT to the network ─────────────────────

export async function pushPsbt(psbtHex: string): Promise<string> {
    const provider = getProvider();
    if (!provider) throw new Error('Wallet not connected');
    const txid: string = await provider.pushPsbt(psbtHex);
    return txid;
}

// ── Listen for wallet events ──────────────────────────────

export function onAccountsChanged(handler: (accounts: string[]) => void): void {
    const provider = getProvider();
    if (!provider) return;
    provider.on('accountsChanged', handler);
}

export function onNetworkChanged(handler: (network: string) => void): void {
    const provider = getProvider();
    if (!provider) return;
    provider.on('networkChanged', handler);
}

export function removeListener(event: WalletEvent, handler: (...args: any[]) => void): void {
    const provider = getProvider();
    if (!provider) return;
    provider.removeListener(event, handler);
}
