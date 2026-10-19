import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { authenticate, type TransportActor } from './transport-auth';

// Synthetic fixtures only: no credentials or plaintext bearer configuration.
const token = (suffix = 'a') => `synthetic-test-only-${suffix.repeat(32)}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const entry = (overrides: Record<string, unknown> = {}) => ({
  tokenSha256: hash(token()), principal: 'worker-1', role: 'executor', environment: 'test', ...overrides,
});
const config = (entries: unknown = [entry()]) => JSON.stringify(entries);
const request = (authorization: string | null = `Bearer ${token()}`, extra: Record<string, string> = {}) =>
  new Request('https://local.invalid', { headers: { ...extra, ...(authorization === null ? {} : { authorization }) } });
const denied = (req: Request, json = config(), environment = 'test') =>
  expect(() => authenticate(req, json, environment)).toThrow(/^Unauthorized$/);

describe('transport authentication', () => {
  it.each(['owner', 'executor', 'verifier', 'projector', 'submitter'] as const)('returns configured %s identity only', role => {
    const actor: TransportActor = authenticate(request(undefined, { 'x-principal': 'attacker', 'x-role': 'owner' }), config([entry({ role })]), 'test');
    expect(actor).toEqual({ principal: 'worker-1', role });
    expect(Object.keys(actor).sort()).toEqual(['principal', 'role']);
  });

  it.each([null, '', 'Basic abc', 'Bearer', 'Bearer short', `Bearer ${'x'.repeat(31)}`,
    `Bearer ${token('b')}`, `Bearer  ${token()}`, `Bearer ${token()} extra`,
    `Bearer ${token()}, Bearer ${token()}`, `Bearer ${token()}:`, `Bearer ${token()}=x`])('rejects absent, unknown or malformed authorization (%#)', authorization => {
    denied(request(authorization));
  });

  it('rejects duplicate Authorization headers even for the same bearer', () => {
    const headers = new Headers();
    headers.append('Authorization', `Bearer ${token()}`);
    headers.append('authorization', `Bearer ${token()}`);
    denied(new Request('https://local.invalid', { headers }));
  });

  it('does not authenticate forged identity headers without a bearer', () => {
    denied(request(null, { 'x-role': 'owner', 'x-principal': 'worker-1', role: 'owner', principal: 'worker-1' }));
  });

  it('binds identities to the exact host environment', () => {
    denied(request(), config(), 'production');
    denied(request(), config(), 'TEST');
    denied(request(), config(), '');
    denied(request(), config(), 'test ');
  });

  it('rejects duplicate digests globally, including different environments and identical entries', () => {
    for (const second of [entry(), entry({ environment: 'production' }), entry({ principal: 'other', role: 'owner' })]) {
      denied(request(), config([entry(), second]));
    }
  });

  it.each(['', '{', 'null', '{}', 'true', '42', '"text"'])('fails closed for invalid configuration (%#)', json => {
    denied(request(), json);
  });

  it.each([
    null, [], {}, entry({ tokenSha256: 'A'.repeat(64) }), entry({ tokenSha256: 'a'.repeat(63) }),
    entry({ tokenSha256: 'a'.repeat(64) + '\n' }), entry({ tokenSha256: 'g'.repeat(64) }), entry({ tokenSha256: 123 }),
    entry({ principal: '' }), entry({ principal: 'a'.repeat(65) }), entry({ principal: 'with space' }),
    entry({ principal: 'worker\n' }), entry({ principal: 'é' }), entry({ principal: 123 }), entry({ role: 'admin' }), entry({ role: null }),
    entry({ environment: '' }), entry({ environment: 'a'.repeat(65) }), entry({ environment: 'test\n' }),
    entry({ token: 'not-allowed' }),
    { tokenSha256: hash(token()), principal: 'worker-1', role: 'executor' },
  ])('validates every entry before matching (%#)', invalid => {
    const distinct = entry({ tokenSha256: hash(token('b')) });
    denied(request(), config([distinct, invalid]));
    denied(request(), config([invalid, distinct]));
    denied(request(), config([invalid]));
  });

  it('accepts identifier and token length boundaries and case-insensitive bearer scheme', () => {
    for (const principal of ['a', 'a'.repeat(64), 'A_z-0.']) {
      const bearer = 'z'.repeat(32);
      expect(authenticate(request(`bEaReR ${bearer}`), config([entry({ principal, tokenSha256: hash(bearer) })]), 'test')).toEqual({ principal, role: 'executor' });
    }
  });

  it('selects the matching digest among distinct configured identities', () => {
    expect(authenticate(request(), config([entry({ tokenSha256: hash(token('b')), principal: 'other' }), entry()]), 'test')).toEqual({ principal: 'worker-1', role: 'executor' });
    denied(request(), config([]));
  });

  it('keeps failures generic and never logs authentication material', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      denied(request(), '{invalid-sensitive-config');
      denied(request(`Bearer ${token('unknown')}`));
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
