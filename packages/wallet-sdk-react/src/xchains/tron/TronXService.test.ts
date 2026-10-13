import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChainKeys, spokeChainConfig } from '@sodax/types';
import { TronXService } from './TronXService.js';

const { TRX, USDT } = spokeChainConfig[ChainKeys.TRON_MAINNET].supportedTokens;
const OWNER = 'TYQvjFWzc2Cnt91LXnk7UJVii3JVfSm69d';
const OWNER_HEX = '41f62fffa4d92bcdfc310dccbe943747fe8302e871';
const USDT_HEX = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c';
const RPC = 'https://tron.example';

type Call = { url: string; body: Record<string, unknown> };

/** Stands in for TronGrid: records each call and answers every one with `answer`. */
function stubFetch(answer: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return new Response(JSON.stringify(answer));
    }),
  );
  return calls;
}

const service = TronXService.getInstance({ rpcUrl: RPC });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('TronXService.getBalance', () => {
  it('returns 0n without a network call when no address is connected', async () => {
    const calls = stubFetch({});
    expect(await service.getBalance(undefined, USDT)).toBe(0n);
    expect(calls).toHaveLength(0);
  });

  it('reads native TRX from the account balance', async () => {
    const calls = stubFetch({ balance: 1_500_000 });

    expect(await service.getBalance(OWNER, TRX)).toBe(1_500_000n);
    expect(calls[0]).toEqual({ url: `${RPC}/wallet/getaccount`, body: { address: OWNER, visible: true } });
  });

  it('reads a TRC-20 balanceOf with hex owner and contract', async () => {
    const calls = stubFetch({
      result: { result: true },
      constant_result: ['00000000000000000000000000000000000000000000000000000000017cfb67'],
    });

    expect(await service.getBalance(OWNER, USDT)).toBe(0x17cfb67n);
    expect(calls[0]?.url).toBe(`${RPC}/wallet/triggerconstantcontract`);
    expect(calls[0]?.body).toMatchObject({
      owner_address: OWNER_HEX,
      contract_address: USDT_HEX,
      function_selector: 'balanceOf(address)',
      parameter: OWNER_HEX.slice(2).padStart(64, '0'),
    });
  });

  // Response shapes captured from TronGrid. The old read turned these into 0n or a garbage balance.
  it.each([
    ['not a contract', { result: { code: 'CONTRACT_VALIDATE_ERROR', message: 'Smart contract is not exist.' } }],
    ['reverted', { result: { result: true, message: 'REVERT opcode executed' }, constant_result: [''] }],
    ['reverted with a reason', { result: { result: true }, constant_result: [`08c379a0${'00'.repeat(96)}`] }],
  ])('reports a failed TRC-20 read (%s) as 0n, never a parsed balance', async (_label, answer) => {
    stubFetch(answer);
    expect(await service.getBalance(OWNER, USDT)).toBe(0n);
  });

  it.each([
    ['checksum typo', 'TYQvjFWzc2Cnt91LXnk7UJVii3JVfSm69e'],
    ['invalid base58 char', 'TYQvjFWzc2Cnt91LXnk7UJVii3JVfSm690'],
    ['bare 20-byte hex', `0x${OWNER_HEX.slice(2)}`],
  ])('refuses a malformed owner address (%s) before querying the node', async (_label, owner) => {
    const calls = stubFetch({ result: { result: true }, constant_result: ['00'.repeat(32)] });

    expect(await service.getBalance(owner, USDT)).toBe(0n);
    expect(calls).toHaveLength(0);
  });
});
