import { bytesToHex, hexToBytes, sha256 } from 'viem';
import { XService } from '@/core/XService.js';
import type { XToken } from '@sodax/types';

import { TRON_DEFAULT_RPC_URL } from '@/constants.js';

/** Zero-address sentinel the token lists use for native TRX. */
const TRON_NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const TRON_ADDRESS_HEX = /^41[0-9a-fA-F]{40}$/;

/**
 * Tron address → 41-prefixed hex (21 bytes). Accepts valid base58check (25 bytes, `0x41` version,
 * matching checksum) or that same 21-byte hex, with or without `0x`; anything else throws.
 */
function tronToHex(addr: string): string {
  const hex = addr.startsWith('0x') ? addr.slice(2) : addr;
  if (TRON_ADDRESS_HEX.test(hex)) return hex;
  if (addr.startsWith('0x')) throw new Error(`invalid Tron address hex: ${addr}`);

  let n = 0n;
  for (const c of addr) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`invalid base58 char in Tron address: ${addr}`);
    n = n * 58n + BigInt(i);
  }
  const body = n === 0n ? '' : n.toString(16);
  const leadingZeros = addr.length - addr.replace(/^1+/, '').length;
  const bytes = hexToBytes(`0x${'00'.repeat(leadingZeros)}${body.length % 2 ? '0' : ''}${body}`);
  if (bytes.length !== 25 || bytes[0] !== 0x41) throw new Error(`invalid Tron address: ${addr}`);
  const payload = bytes.subarray(0, 21);
  const checksum = sha256(sha256(payload, 'bytes'), 'bytes').subarray(0, 4);
  if (!checksum.every((b, i) => b === bytes[21 + i])) throw new Error(`invalid Tron address checksum: ${addr}`);
  return bytesToHex(payload).slice(2);
}

export class TronXService extends XService {
  private static instance: TronXService;

  public rpcUrl: string;

  private constructor(config?: { rpcUrl?: string }) {
    super('TRON');
    this.rpcUrl = config?.rpcUrl ?? TRON_DEFAULT_RPC_URL;
  }

  public static getInstance(config?: { rpcUrl?: string }): TronXService {
    if (!TronXService.instance) {
      TronXService.instance = new TronXService(config);
    } else if (config?.rpcUrl) {
      TronXService.instance.rpcUrl = config.rpcUrl;
    }
    return TronXService.instance;
  }

  private post(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.rpcUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** @warning Any fetch failure returns `0n`, indistinguishable from a zero balance. */
  override async getBalance(address: string | undefined, xToken: XToken): Promise<bigint> {
    if (!address) return 0n;
    try {
      // Native TRX
      if (xToken.symbol === 'TRX' || xToken.address.toLowerCase() === TRON_NATIVE_TOKEN_ADDRESS) {
        const res = await this.post('/wallet/getaccount', { address, visible: true });
        const data = (await res.json()) as { balance?: number };
        return BigInt(data.balance ?? 0);
      }
      // TRC-20 balanceOf(address)
      const ownerHex = tronToHex(address);
      const param = ownerHex.replace(/^41/, '').padStart(64, '0');
      const res = await this.post('/wallet/triggerconstantcontract', {
        owner_address: ownerHex,
        contract_address: tronToHex(xToken.address),
        function_selector: 'balanceOf(address)',
        parameter: param,
        visible: false,
      });
      const data = (await res.json()) as {
        result?: { result?: boolean; message?: string };
        constant_result?: string[];
      };
      // A failed read still answers 200; parsing its word (empty, or a revert reason) shows a garbage balance.
      const word = data.constant_result?.[0];
      if (data.result?.result !== true || !word || !/^[0-9a-fA-F]{64}$/.test(word)) {
        throw new Error(`balanceOf on ${xToken.address} failed: ${data.result?.message ?? 'no result'}`);
      }
      return BigInt(`0x${word}`);
    } catch (error) {
      console.error('Error fetching Tron balance:', error);
      return 0n;
    }
  }
}
