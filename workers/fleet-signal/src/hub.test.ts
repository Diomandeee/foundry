import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { bytesToB64, canonical, derToRaw, requestSigningString } from './crypto';
import { HubError, SignalHub, type SqlPort } from './hub';

const enc = new TextEncoder();

function sqlPort(): SqlPort {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      if (/^\s*(SELECT|WITH)/i.test(query)) return stmt.all(...(bindings as never[])) as Record<string, unknown>[];
      stmt.run(...(bindings as never[]));
      return [];
    },
  };
}

/** Raw r||s -> DER, as CryptoKit's derRepresentation produces. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = Uint8Array.from([0, ...v]);
    return Uint8Array.from([0x02, v.length, ...v]);
  };
  const r = int(raw.slice(0, 32)), s = int(raw.slice(32));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

async function keypair() {
  const k = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const spki = bytesToB64(new Uint8Array((await crypto.subtle.exportKey('spki', k.publicKey)) as ArrayBuffer));
  const sign = async (data: string) => bytesToB64(rawToDer(new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.privateKey, enc.encode(data)))));
  return { spki, sign };
}

async function signed(key: { sign: (s: string) => Promise<string> }, keyId: string, method: string, path: string, body: string, ts: number) {
  return { keyId, ts: String(ts), signature: await key.sign(await requestSigningString(method, path, String(ts), body)) };
}

async function setup() {
  let t = 1_800_000_000;
  const pushes: unknown[] = [];
  const hub = new SignalHub(sqlPort(), () => t, { notifyRequest: async (d, r) => { pushes.push({ d, r }); } });
  const node = await keypair(), phone = await keypair(), other = await keypair();
  hub.enrollNode('mac5-node', 'mac5', node.spki);
  hub.enrollDevice('iphone', phone.spki, 'Mohamed iPhone', 'apns-token-1', 'sandbox');
  const payload = canonical({ v: 1, host: 'mac5', request_id: 'c94065cb9815395f', fp: 'a'.repeat(64), tier: 3, nonce: 'n'.repeat(32),
    expires_at: t + 1800, staged_at: t, description: 'Mac VM worker request 17', script: 'echo hi', script_sha256: 'b'.repeat(64) });
  return { hub, node, phone, other, payload, pushes, tick: (s: number) => { t += s; }, now: () => t };
}

describe('fleet-signal hub', () => {
  it('derToRaw round-trips CryptoKit-style DER', async () => {
    const raw = new Uint8Array(64).map((_, i) => (i * 7 + 200) & 0xff);
    expect(derToRaw(rawToDer(raw))).toEqual(raw);
  });

  it('relays a node-signed request to the device and pushes it', async () => {
    const s = await setup();
    const p = await s.hub.authenticate(await signed(s.node, 'mac5-node', 'POST', '/v1/requests', '{}', s.now()), 'POST', '/v1/requests', '{}');
    expect(await s.hub.publishRequest(p, s.payload, await s.node.sign(s.payload))).toEqual({ stored: true });
    expect(s.pushes).toHaveLength(1);
    const dev = await s.hub.authenticate(await signed(s.phone, 'iphone', 'GET', '/v1/requests/mac5/c94065cb9815395f', '', s.now()),
      'GET', '/v1/requests/mac5/c94065cb9815395f', '');
    const got = s.hub.getRequest(dev, 'mac5', 'c94065cb9815395f');
    expect(got.payload).toBe(s.payload);
    expect(s.hub.pending(dev)).toHaveLength(1);
  });

  it('refuses a request not signed by the enrolled node key (relay cannot forge)', async () => {
    const s = await setup();
    const p = await s.hub.authenticate(await signed(s.node, 'mac5-node', 'POST', '/v1/requests', '{}', s.now()), 'POST', '/v1/requests', '{}');
    await expect(s.hub.publishRequest(p, s.payload, await s.other.sign(s.payload))).rejects.toThrow('bad-request-signature');
  });

  it('refuses replayed and stale HTTP signatures', async () => {
    const s = await setup();
    const h = await signed(s.node, 'mac5-node', 'POST', '/v1/requests', '{}', s.now());
    await s.hub.authenticate(h, 'POST', '/v1/requests', '{}');
    await expect(s.hub.authenticate(h, 'POST', '/v1/requests', '{}')).rejects.toThrow('replayed-signature');
    const old = await signed(s.node, 'mac5-node', 'POST', '/v1/requests', '{}', s.now() - 500);
    await expect(s.hub.authenticate(old, 'POST', '/v1/requests', '{}')).rejects.toThrow('stale-signature');
  });

  it('accepts a matching device-signed decision and hands it to the node exactly once', async () => {
    const s = await setup();
    const np = await s.hub.authenticate(await signed(s.node, 'mac5-node', 'POST', '/v1/requests', '{}', s.now()), 'POST', '/v1/requests', '{}');
    await s.hub.publishRequest(np, s.payload, await s.node.sign(s.payload));
    const r = JSON.parse(s.payload);
    const msg = canonical({ v: 1, host: 'mac5', request_id: r.request_id, fp: r.fp, tier: r.tier, nonce: r.nonce,
      expires_at: r.expires_at, issued_at: s.now(), decision: 'approve' });
    const dev = await s.hub.authenticate(await signed(s.phone, 'iphone', 'POST', '/v1/decisions', '{}', s.now()), 'POST', '/v1/decisions', '{}');
    expect((await s.hub.submitDecision(dev, msg, await s.phone.sign(msg))).seq).toBe(1);
    await expect(s.hub.submitDecision(dev, msg, await s.phone.sign(msg))).rejects.toThrow('already-decided');
    s.tick(1);
    const np2 = await s.hub.authenticate(await signed(s.node, 'mac5-node', 'GET', '/v1/decisions?after=0', '', s.now()), 'GET', '/v1/decisions?after=0', '');
    const ds = s.hub.decisionsFor(np2, 0);
    expect(ds).toHaveLength(1);
    expect(ds[0].message).toBe(msg);
    expect(s.hub.decisionsFor(np2, 1)).toHaveLength(0);
  });

  it('refuses a decision whose fields do not match the staged request', async () => {
    const s = await setup();
    const np = await s.hub.authenticate(await signed(s.node, 'mac5-node', 'POST', '/v1/requests', '{}', s.now()), 'POST', '/v1/requests', '{}');
    await s.hub.publishRequest(np, s.payload, await s.node.sign(s.payload));
    const r = JSON.parse(s.payload);
    const msg = canonical({ v: 1, host: 'mac5', request_id: r.request_id, fp: 'c'.repeat(64), tier: r.tier, nonce: r.nonce,
      expires_at: r.expires_at, issued_at: s.now(), decision: 'approve' });
    const dev = await s.hub.authenticate(await signed(s.phone, 'iphone', 'POST', '/v1/decisions', '{}', s.now()), 'POST', '/v1/decisions', '{}');
    await expect(s.hub.submitDecision(dev, msg, await s.phone.sign(msg))).rejects.toThrow('decision-does-not-match-request');
  });

  it('enforces receipt hash-chain linkage', async () => {
    const s = await setup();
    const np = await s.hub.authenticate(await signed(s.node, 'mac5-node', 'POST', '/v1/receipts', '{}', s.now()), 'POST', '/v1/receipts', '{}');
    const h = (c: string) => c.repeat(64);
    expect(s.hub.appendReceipts(np, [{ seq: 1, hash: h('1'), prev: '' }, { seq: 2, hash: h('2'), prev: h('1') }]).stored).toBe(2);
    expect(s.hub.appendReceipts(np, [{ seq: 2, hash: h('2'), prev: h('1') }]).stored).toBe(0);
    expect(() => s.hub.appendReceipts(np, [{ seq: 3, hash: h('3'), prev: h('9') }])).toThrow(HubError);
  });

  it('only devices read the feed; nodes cannot decide', async () => {
    const s = await setup();
    const np = await s.hub.authenticate(await signed(s.node, 'mac5-node', 'GET', '/v1/feed', '', s.now()), 'GET', '/v1/feed', '');
    expect(() => s.hub.feed(np, 0)).toThrow('device-only');
    await expect(s.hub.submitDecision(np, '{}', 'x')).rejects.toThrow('device-only');
  });
});
