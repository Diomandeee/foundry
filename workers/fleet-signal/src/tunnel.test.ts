import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { bytesToB64, requestSigningString } from './crypto';
import { SignalHub, type Alert, type SqlPort } from './hub';
import { Tunnel } from './tunnel';

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

async function keypair() {
  const k = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const spki = bytesToB64(new Uint8Array((await crypto.subtle.exportKey('spki', k.publicKey)) as ArrayBuffer));
  const sign = async (data: string) => bytesToB64(new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.privateKey, enc.encode(data))));
  return { spki, sign };
}

async function headers(key: { sign: (s: string) => Promise<string> }, keyId: string, method: string, path: string, body: string, ts: number) {
  return { keyId, ts: String(ts), signature: await key.sign(await requestSigningString(method, path, String(ts), body)) };
}

async function setup() {
  const t = 1_800_000_000;
  const alerts: Alert[] = [];
  const hub = new SignalHub(sqlPort(), () => t, {
    notifyRequest: async () => {},
    notifyAlert: async (_d, a) => { alerts.push(a); },
  });
  const phone = await keypair(), bridge = await keypair(), stranger = await keypair();
  hub.enrollDevice('iphone', phone.spki, 'phone', 'ab'.repeat(32), 'sandbox', phone.spki, true);
  const dev = await hub.authenticate(await headers(phone, 'iphone', 'POST', '/v1/bridges', '{}', t), 'POST', '/v1/bridges', '{}');
  return { hub, phone, bridge, stranger, dev, alerts, t };
}

describe('fabric bridge tunnel', () => {
  it('only a registered bridge key authenticates as that bridge', async () => {
    const s = await setup();
    await expect(s.hub.authenticate(await headers(s.bridge, 'bridge:mac1', 'GET', '/v1/bridge-tunnel/poll', '', s.t),
      'GET', '/v1/bridge-tunnel/poll', '')).rejects.toThrow('unknown-key');
    await s.hub.registerBridge(s.dev, 'mac1', s.bridge.spki);
    const p = await s.hub.authenticate(await headers(s.bridge, 'bridge:mac1', 'GET', '/v1/bridge-tunnel/poll', '', s.t),
      'GET', '/v1/bridge-tunnel/poll', '');
    expect(p).toEqual({ kind: 'bridge', id: 'mac1' });
    await expect(s.hub.authenticate(await headers(s.stranger, 'bridge:mac1', 'GET', '/v1/bridge-tunnel/poll?x', '', s.t),
      'GET', '/v1/bridge-tunnel/poll?x', '')).rejects.toThrow('bad-signature');
  });

  it('the owner can revoke a bridge key', async () => {
    const s = await setup();
    await s.hub.registerBridge('owner', 'mac4', s.bridge.spki);
    await s.hub.authenticate(await headers(s.bridge, 'bridge:mac4', 'GET', '/v1/bridge-tunnel/poll', '', s.t), 'GET', '/v1/bridge-tunnel/poll', '');
    s.hub.revoke('bridge', 'mac4');
    await expect(s.hub.authenticate(await headers(s.bridge, 'bridge:mac4', 'GET', '/v1/bridge-tunnel/poll?again', '', s.t),
      'GET', '/v1/bridge-tunnel/poll?again', '')).rejects.toThrow('unknown-key');
    expect(s.hub.bridges(s.dev).map((b) => b.machine)).not.toContain('mac4');
  });

  it('a bridge cannot register bridges, read the list, or decide; bad keys are refused', async () => {
    const s = await setup();
    await s.hub.registerBridge(s.dev, 'mac1', s.bridge.spki);
    const bp = { kind: 'bridge', id: 'mac1' } as const;
    await expect(s.hub.registerBridge(bp, 'mac4', s.stranger.spki)).rejects.toThrow('device-only');
    expect(() => s.hub.bridges(bp)).toThrow('device-only');
    await expect(s.hub.submitDecision(bp, '{}', 'x')).rejects.toThrow('device-only');
    await expect(s.hub.registerBridge(s.dev, 'mac 1', s.bridge.spki)).rejects.toThrow('invalid-bridge');
    await expect(s.hub.registerBridge(s.dev, 'mac4', 'bm90LWEta2V5')).rejects.toThrow('invalid-bridge-key');
    expect(s.hub.bridges(s.dev).map(b => b.machine)).toEqual(['mac1']);
  });

  it('pushes a Claude ask from a bridge, with the ask id for the app', async () => {
    const s = await setup();
    await s.hub.alert({ kind: 'bridge', id: 'mac5' }, 'Claude on mac5 needs your OK', 'Fabric Pilot: Bash rm -rf build', 'ask-1');
    expect(s.alerts).toEqual([{ title: 'Claude on mac5 needs your OK', body: 'Fabric Pilot: Bash rm -rf build',
                                data: { claude_ask: 'ask-1', bridge_machine: 'mac5' } }]);
    await expect(s.hub.alert(s.dev, 't', 'b', 'ask-2')).rejects.toThrow('bridge-only');
  });

  it('hands a phone call to a waiting poll and returns the bridge result', async () => {
    let now = 0;
    const tn = new Tunnel(() => now, () => 'job-1');
    expect(tn.online('mac1')).toBe(false);
    const poll = tn.poll('mac1', 25_000);
    expect(tn.online('mac1')).toBe(true);
    const call = tn.request('mac1', { method: 'GET', path: '/v1/sessions', headers: { 'x-fs-key': 'iphone' }, body: '' }, 35_000);
    const jobs = await poll;
    expect(jobs).toEqual([{ id: 'job-1', method: 'GET', path: '/v1/sessions', headers: { 'x-fs-key': 'iphone' }, body: '' }]);
    expect(tn.reply('mac4', 'job-1', { status: 200, body: 'forged', rsig: '' })).toBe(false);  // another bridge cannot answer it
    expect(tn.reply('mac1', 'job-1', { status: 200, body: '{"sessions":[]}', rsig: 'sig' })).toBe(true);
    expect(await call).toEqual({ status: 200, body: '{"sessions":[]}', rsig: 'sig' });
    expect(tn.reply('mac1', 'job-1', { status: 200, body: 'again', rsig: '' })).toBe(false);
    now = 61_000;
    expect(tn.online('mac1')).toBe(false);
  });

  it('queues calls made between polls and times out unanswered ones', async () => {
    let n = 0;
    const tn = new Tunnel(() => 0, () => `job-${++n}`);
    const a = tn.request('mac5', { method: 'GET', path: '/v1/hello', headers: {}, body: '' }, 20);
    const b = tn.request('mac5', { method: 'GET', path: '/v1/sessions', headers: {}, body: '' }, 5_000);
    expect(await a).toEqual({ status: 504, body: '{"error":"bridge-timeout"}', rsig: '' });
    const jobs = await tn.poll('mac5', 1_000);
    expect(jobs.map(j => j.path)).toEqual(['/v1/sessions']);  // the timed-out call is no longer delivered
    tn.reply('mac5', jobs[0].id, { status: 200, body: 'ok', rsig: '' });
    expect((await b).body).toBe('ok');
    expect(await tn.poll('mac5', 10)).toEqual([]);
  });

  it('a newer poll from the same bridge releases the older one', async () => {
    const tn = new Tunnel(() => 0);
    const first = tn.poll('mac4', 10_000);
    const second = tn.poll('mac4', 50);
    expect(await first).toEqual([]);
    expect(await second).toEqual([]);
  });
});
