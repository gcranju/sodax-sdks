import { afterEach, describe, expect, it, vi } from 'vitest';
import { concat, keccak256, recoverAddress, stringToBytes, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { TronUnsignedTransaction } from '@sodax/types';
import { TronWalletProvider } from './TronWalletProvider.js';
import type { TronProviderLike, TronWebLike } from './types.js';

const PK = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const EVM_ADDRESS = privateKeyToAccount(PK).address;
// base58check(0x41 ‖ EVM_ADDRESS), cross-checked against the SDK's own encoder.
const TRON_ADDRESS = 'TCWfJguCLonUkvmsptQKHUyUJ713pU7XQ1';
const BROWSER_ADDRESS = 'TKEsLgfqRdC9PX88hvW1WWnMhH53qCMe92';
const TX: TronUnsignedTransaction = { txID: 'ab'.repeat(32), raw_data_hex: '0a02abcd', visible: false };
const HASH = `0x${'cd'.repeat(32)}` as const;
const BROWSER_SIG = 'ef'.repeat(65);

type Call = { url: string; body: Record<string, unknown> };

/** Stands in for TronGrid: records each call and answers with the next body (repeating the last). */
function stubFetch(...answers: unknown[]): Call[] {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      const answer = answers[Math.min(i++, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return new Response(JSON.stringify(answer));
    }),
  );
  return calls;
}

function tronWeb(base58?: string | false): TronWebLike {
  return {
    defaultAddress: base58 === undefined ? undefined : { base58 },
    trx: {
      sign: vi.fn(async (tx: TronUnsignedTransaction) => ({ ...tx, signature: [BROWSER_SIG] })),
      signMessageV2: vi.fn(async () => BROWSER_SIG),
    },
  };
}

const announced = (tw: TronWebLike): TronProviderLike => ({ request: vi.fn(), tronWeb: tw });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('TronWalletProvider', () => {
  describe('constructor', () => {
    it('initializes with a private key, with or without the 0x prefix', async () => {
      const prefixed = new TronWalletProvider({ privateKey: PK });
      const bare = new TronWalletProvider({ privateKey: PK.slice(2) });

      expect(prefixed.chainType).toBe('TRON');
      expect(await bare.getWalletAddress()).toBe(await prefixed.getWalletAddress());
    });

    it('initializes with browser-extension config', () => {
      const provider = new TronWalletProvider({ tronWeb: tronWeb(BROWSER_ADDRESS) });
      expect(provider.chainType).toBe('TRON');
    });

    it('throws on invalid config', () => {
      expect(() => new TronWalletProvider({} as never)).toThrow('Invalid Tron wallet configuration');
    });
  });

  describe('rpc endpoint', () => {
    it('defaults to TronGrid', async () => {
      const calls = stubFetch({ balance: 1 });
      await new TronWalletProvider({ privateKey: PK }).getBalance(TRON_ADDRESS);
      expect(calls[0]?.url).toBe('https://api.trongrid.io/wallet/getaccount');
    });

    it('takes defaults.rpcUrl over the default, and endpoint over both', async () => {
      const calls = stubFetch({ balance: 1 });
      const defaults = { rpcUrl: 'https://defaults.example' };

      await new TronWalletProvider({ privateKey: PK, defaults }).getBalance(TRON_ADDRESS);
      await new TronWalletProvider({ privateKey: PK, defaults, endpoint: 'https://endpoint.example' }).getBalance(
        TRON_ADDRESS,
      );

      expect(calls.map(c => c.url)).toEqual([
        'https://defaults.example/wallet/getaccount',
        'https://endpoint.example/wallet/getaccount',
      ]);
    });
  });

  describe('getWalletAddress', () => {
    it('derives the base58 address from the key: 0x41 plus the EVM address hash', async () => {
      expect(await new TronWalletProvider({ privateKey: PK }).getWalletAddress()).toBe(TRON_ADDRESS);
    });

    it('prefers the configured browser address over the injected TronWeb account', async () => {
      const provider = new TronWalletProvider({ tronWeb: tronWeb(TRON_ADDRESS), address: BROWSER_ADDRESS });
      expect(await provider.getWalletAddress()).toBe(BROWSER_ADDRESS);
    });

    it('falls back to the injected TronWeb account', async () => {
      const provider = new TronWalletProvider({ tronWeb: tronWeb(BROWSER_ADDRESS) });
      expect(await provider.getWalletAddress()).toBe(BROWSER_ADDRESS);
    });

    it('throws when the browser wallet has no account', async () => {
      const provider = new TronWalletProvider({ tronWeb: tronWeb(false) });
      await expect(provider.getWalletAddress()).rejects.toThrow('Tron wallet not connected');
    });
  });

  describe('signTransaction', () => {
    it('signs the txID with the private key, as r‖s‖v with v as 00/01', async () => {
      const signed = await new TronWalletProvider({ privateKey: PK }).signTransaction(TX);

      expect(signed).toMatchObject(TX);
      expect(signed.signature).toHaveLength(1);
      const signature = signed.signature[0] ?? '';
      expect(signature).toMatch(/^[0-9a-f]{128}0[01]$/);
      expect(await recoverAddress({ hash: `0x${TX.txID}`, signature: `0x${signature}` })).toBe(EVM_ADDRESS);
    });

    it('signs with the connected TronWeb from getProvider() first', async () => {
      const fresh = tronWeb(BROWSER_ADDRESS);
      const captured = tronWeb(BROWSER_ADDRESS);
      const injected = tronWeb(BROWSER_ADDRESS);
      const provider = new TronWalletProvider({
        tronWeb: injected,
        provider: announced(captured),
        getProvider: () => announced(fresh),
      });

      const signed = await provider.signTransaction(TX);

      expect(signed.signature).toEqual([BROWSER_SIG]);
      expect(fresh.trx.sign).toHaveBeenCalledWith(TX);
      expect(captured.trx.sign).not.toHaveBeenCalled();
      expect(injected.trx.sign).not.toHaveBeenCalled();
    });

    it('skips a TronWeb without an account and falls back down the chain', async () => {
      const captured = tronWeb(false);
      const injected = tronWeb(BROWSER_ADDRESS);
      const provider = new TronWalletProvider({
        tronWeb: injected,
        provider: announced(captured),
        getProvider: () => undefined,
      });

      await provider.signTransaction(TX);

      expect(captured.trx.sign).not.toHaveBeenCalled();
      expect(injected.trx.sign).toHaveBeenCalledWith(TX);
    });

    it('refuses to sign when no injected TronWeb has an account', async () => {
      const provider = new TronWalletProvider({ tronWeb: tronWeb(false), provider: announced(tronWeb()) });
      await expect(provider.signTransaction(TX)).rejects.toThrow('the injected Tron wallet is not connected');
    });
  });

  describe('signMessage', () => {
    it("signs the hash's lowercase hex text under the scheme-1 prefix with the private key", async () => {
      const provider = new TronWalletProvider({ privateKey: PK });
      const signature = await provider.signMessage(HASH);

      const digest = keccak256(concat([toBytes('\x19TRON Signed Message:\n66'), stringToBytes(HASH)]));
      expect(await recoverAddress({ hash: digest, signature })).toBe(EVM_ADDRESS);
      // The text is lowercased before signing, so the casing of the input hash does not matter.
      expect(await provider.signMessage(`0x${'CD'.repeat(32)}`)).toBe(signature);
    });

    it('delegates to signMessageV2 in browser mode and returns a 0x-prefixed signature', async () => {
      const injected = tronWeb(BROWSER_ADDRESS);
      const provider = new TronWalletProvider({ tronWeb: injected });

      expect(await provider.signMessage(HASH)).toBe(`0x${BROWSER_SIG}`);
      expect(injected.trx.signMessageV2).toHaveBeenCalledWith(HASH);
    });

    it('keeps a 0x prefix the wallet already returned', async () => {
      const injected = tronWeb(BROWSER_ADDRESS);
      vi.mocked(injected.trx.signMessageV2).mockResolvedValueOnce(`0x${BROWSER_SIG}`);
      const provider = new TronWalletProvider({ tronWeb: injected });

      expect(await provider.signMessage(HASH)).toBe(`0x${BROWSER_SIG}`);
    });
  });

  describe('sendTransaction', () => {
    const signedTx = { ...TX, signature: [BROWSER_SIG] };

    it('broadcasts the signed transaction and returns its txID', async () => {
      const calls = stubFetch({ result: true });

      const txId = await new TronWalletProvider({ privateKey: PK }).sendTransaction(signedTx);

      expect(txId).toBe(TX.txID);
      expect(calls[0]).toEqual({ url: 'https://api.trongrid.io/wallet/broadcasttransaction', body: signedTx });
    });

    it("throws with the node's message when the broadcast is rejected", async () => {
      stubFetch({ result: false, message: 'SIGERROR' });
      await expect(new TronWalletProvider({ privateKey: PK }).sendTransaction(signedTx)).rejects.toThrow(
        'Tron broadcast failed: SIGERROR',
      );
    });
  });

  describe('getBalance', () => {
    it("reads the wallet's own TRX balance in sun when no address is given", async () => {
      const calls = stubFetch({ balance: 1_500_000 });

      expect(await new TronWalletProvider({ privateKey: PK }).getBalance()).toBe(1_500_000n);
      expect(calls[0]?.body).toEqual({ address: TRON_ADDRESS, visible: true });
    });

    it('reports an account the node does not know as 0n', async () => {
      stubFetch({});
      expect(await new TronWalletProvider({ privateKey: PK }).getBalance(TRON_ADDRESS)).toBe(0n);
    });

    it('swallows a failed read as 0n', async () => {
      stubFetch(new Error('network down'));
      expect(await new TronWalletProvider({ privateKey: PK }).getBalance(TRON_ADDRESS)).toBe(0n);
    });
  });

  describe('waitForTransactionReceipt', () => {
    it('polls by bare tx id until the transaction is in a block', async () => {
      vi.useFakeTimers();
      const receipt = { id: TX.txID, blockNumber: 42 };
      const calls = stubFetch({}, receipt);

      const pending = new TronWalletProvider({ privateKey: PK }).waitForTransactionReceipt(`0x${TX.txID}`);
      await vi.advanceTimersByTimeAsync(3_000);

      await expect(pending).resolves.toEqual(receipt);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual({
        url: 'https://api.trongrid.io/wallet/gettransactioninfobyid',
        body: { value: TX.txID },
      });
    });
  });
});
