// fleet-signal core: the relay between each Mac's fleet-authority daemon and the
// Fabric iPhone app (DELEGATED-AUTHORITY S2). Storage-agnostic: runs over a tiny
// SQL port (Durable Object SQLite in production, node:sqlite in tests).
//
// Trust model: this service is NOT an authority.
//  - A staged request is signed by the node (Mac daemon) key; the app verifies
//    that signature against the node key it pinned at enrollment, so the relay
//    cannot forge or alter what you approve.
//  - A decision is signed by the device (Secure Enclave) key; the daemon
//    re-verifies it (approve_signed) against its own enrolled keys before running
//    anything, so the relay cannot approve.
// The relay checks both signatures too (defense in depth), stores everything
// append-only, and pushes notifications.

import { canonical, requestSigningString, sha256Hex, verifyP256 } from './crypto';

export interface SqlPort {
  exec(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>>;
}

export class HubError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS nodes (node_id TEXT PRIMARY KEY, host TEXT NOT NULL UNIQUE, spki TEXT NOT NULL,
     enrolled_at INTEGER NOT NULL, revoked_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY, spki TEXT NOT NULL, label TEXT,
     apns_token TEXT, apns_env TEXT, enrolled_at INTEGER NOT NULL, revoked_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS requests (host TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL,
     signature TEXT NOT NULL, fp TEXT NOT NULL, tier INTEGER NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL,
     description TEXT, received_at INTEGER NOT NULL, PRIMARY KEY (host, request_id))`,
  `CREATE TABLE IF NOT EXISTS decisions (host TEXT NOT NULL, request_id TEXT NOT NULL, message TEXT NOT NULL,
     signature TEXT NOT NULL, key_id TEXT NOT NULL, decision TEXT NOT NULL, received_at INTEGER NOT NULL,
     seq INTEGER NOT NULL, PRIMARY KEY (host, request_id))`,
  // v3 (review H5): one decision per (host, request, approver key), so another device cannot squat a request.
  `CREATE TABLE IF NOT EXISTS decisions2 (host TEXT NOT NULL, request_id TEXT NOT NULL, key_id TEXT NOT NULL, message TEXT NOT NULL,
     signature TEXT NOT NULL, decision TEXT NOT NULL, received_at INTEGER NOT NULL, seq INTEGER NOT NULL,
     PRIMARY KEY (host, request_id, key_id))`,
  `CREATE TABLE IF NOT EXISTS receipts (host TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL,
     prev TEXT NOT NULL, entry TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY (host, seq))`,
  `CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, source TEXT NOT NULL,
     kind TEXT NOT NULL, body TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS seen_signatures (sig_hash TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
];

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_SKEW_S = 120;
const MAX_ISSUED_SKEW_S = 300;

export interface SignedHeaders { keyId: string; ts: string; signature: string }
export type Principal = { kind: 'node'; id: string; host: string } | { kind: 'device'; id: string };

export interface PushPort {
  notifyRequest(devices: { device_id: string; apns_token: string; apns_env: string }[],
    req: { host: string; request_id: string; tier: number; description: string }): Promise<void>;
}

export class SignalHub {
  constructor(private sql: SqlPort, private now: () => number = () => Math.floor(Date.now() / 1000),
              private push?: PushPort) {
    for (const s of SCHEMA) this.sql.exec(s);
    // v2: a device has two keys. `spki` authenticates HTTP calls (no user prompt); `decision_spki`
    // (Secure Enclave, Face ID gated) signs approve/deny. Older rows fall back to `spki`.
    const cols = this.all("SELECT name FROM pragma_table_info('devices')").map(r => String(r.name));
    if (!cols.includes('decision_spki')) this.sql.exec('ALTER TABLE devices ADD COLUMN decision_spki TEXT');
    if (!cols.includes('biometric')) this.sql.exec('ALTER TABLE devices ADD COLUMN biometric INTEGER');
  }

  private one(q: string, ...b: unknown[]): Record<string, unknown> | undefined {
    for (const r of this.sql.exec(q, ...b)) return r;
    return undefined;
  }
  private all(q: string, ...b: unknown[]): Record<string, unknown>[] {
    return [...this.sql.exec(q, ...b)];
  }
  private next(name: string): number {
    const cur = Number(this.one('SELECT value FROM counters WHERE name = ?', name)?.value ?? 0) + 1;
    this.sql.exec('INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value', name, cur);
    return cur;
  }
  private event(source: string, kind: string, body: unknown): void {
    this.sql.exec('INSERT INTO events (at, source, kind, body) VALUES (?, ?, ?, ?)', this.now(), source, kind, JSON.stringify(body));
  }

  // ── owner (bearer-authenticated at the HTTP layer) ──────────────────────────
  enrollNode(nodeId: string, host: string, spki: string): void {
    if (!ID.test(nodeId) || !ID.test(host) || !spki) throw new HubError(400, 'invalid-node');
    this.sql.exec('INSERT INTO nodes (node_id, host, spki, enrolled_at) VALUES (?, ?, ?, ?)', nodeId, host, spki, this.now());
    this.event('owner', 'node.enrolled', { nodeId, host });
  }
  enrollDevice(deviceId: string, spki: string, label: string | null, apnsToken: string | null, apnsEnv: string | null,
               decisionSpki: string | null = null, biometric = false): void {
    if (!ID.test(deviceId) || !spki) throw new HubError(400, 'invalid-device');
    // Review C3: an approver must prove a person by biometry; passcode-only devices are refused at the door.
    if (!decisionSpki || !biometric) throw new HubError(400, 'device-not-biometric');
    if (apnsEnv && !['sandbox', 'production'].includes(apnsEnv)) throw new HubError(400, 'invalid-apns-env');
    this.sql.exec('INSERT INTO devices (device_id, spki, label, apns_token, apns_env, enrolled_at, decision_spki, biometric) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
      deviceId, spki, label, apnsToken, apnsEnv, this.now(), decisionSpki);
    this.event('owner', 'device.enrolled', { deviceId, label });
  }
  revoke(kind: 'node' | 'device', id: string): void {
    const table = kind === 'node' ? 'nodes' : 'devices';
    const col = kind === 'node' ? 'node_id' : 'device_id';
    this.sql.exec(`UPDATE ${table} SET revoked_at = ? WHERE ${col} = ? AND revoked_at IS NULL`, this.now(), id);
    this.event('owner', `${kind}.revoked`, { id });
  }

  // ── signed-request authentication (nodes and devices) ───────────────────────
  async authenticate(h: SignedHeaders, method: string, pathWithQuery: string, body: string): Promise<Principal> {
    const ts = Number(h.ts);
    if (!h.keyId || !h.signature || !Number.isInteger(ts)) throw new HubError(401, 'missing-signature');
    if (Math.abs(this.now() - ts) > MAX_SKEW_S) throw new HubError(401, 'stale-signature');
    const node = this.one('SELECT node_id, host, spki FROM nodes WHERE node_id = ? AND revoked_at IS NULL', h.keyId);
    const device = node ? undefined : this.one('SELECT device_id, spki FROM devices WHERE device_id = ? AND revoked_at IS NULL', h.keyId);
    const spki = (node?.spki ?? device?.spki) as string | undefined;
    if (!spki) throw new HubError(401, 'unknown-key');
    const msg = await requestSigningString(method, pathWithQuery, h.ts, body);
    if (!(await verifyP256(spki, h.signature, msg))) throw new HubError(401, 'bad-signature');
    const sigHash = await sha256Hex(h.signature);
    this.sql.exec('DELETE FROM seen_signatures WHERE at < ?', this.now() - 2 * MAX_SKEW_S);
    if (this.one('SELECT 1 AS x FROM seen_signatures WHERE sig_hash = ?', sigHash)) throw new HubError(401, 'replayed-signature');
    this.sql.exec('INSERT INTO seen_signatures (sig_hash, at) VALUES (?, ?)', sigHash, this.now());
    return node ? { kind: 'node', id: String(node.node_id), host: String(node.host) } : { kind: 'device', id: String(device!.device_id) };
  }

  // ── node: publish a staged request (node-signed payload, end-to-end) ─────────
  async publishRequest(p: Principal, payload: string, signature: string): Promise<{ stored: boolean }> {
    if (p.kind !== 'node') throw new HubError(403, 'node-only');
    const node = this.one('SELECT spki FROM nodes WHERE node_id = ?', p.id)!;
    if (!(await verifyP256(String(node.spki), signature, payload))) throw new HubError(400, 'bad-request-signature');
    let r: Record<string, unknown>;
    try { r = JSON.parse(payload); } catch { throw new HubError(400, 'payload-not-json'); }
    if (canonical(r) !== payload) throw new HubError(400, 'payload-not-canonical');
    if (r.v !== 1 || r.host !== p.host || !ID.test(String(r.request_id)) || !HEX64.test(String(r.fp)) ||
        !Number.isInteger(r.tier) || typeof r.nonce !== 'string' || !Number.isInteger(r.expires_at))
      throw new HubError(400, 'invalid-request-payload');
    if (Number(r.expires_at) <= this.now()) throw new HubError(400, 'request-already-expired');
    const existing = this.one('SELECT fp FROM requests WHERE host = ? AND request_id = ?', r.host, r.request_id);
    if (existing) {
      if (existing.fp !== r.fp) throw new HubError(409, 'request-id-reused');
      return { stored: false };
    }
    const description = String(r.description ?? '').slice(0, 2000);
    this.sql.exec(`INSERT INTO requests (host, request_id, payload, signature, fp, tier, nonce, expires_at, description, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, r.host, r.request_id, payload, signature, r.fp, r.tier, r.nonce, r.expires_at, description, this.now());
    this.event(p.id, 'request.staged', { host: r.host, request_id: r.request_id, tier: r.tier, description });
    if (this.push) {
      const devices = this.all(`SELECT device_id, apns_token, apns_env FROM devices
        WHERE revoked_at IS NULL AND apns_token IS NOT NULL`) as { device_id: string; apns_token: string; apns_env: string }[];
      if (devices.length) {
        try {
          await this.push.notifyRequest(devices, { host: String(r.host), request_id: String(r.request_id), tier: Number(r.tier), description });
        } catch (e) {
          this.event('hub', 'push.failed', { request_id: r.request_id, error: String(e) });
        }
      }
    }
    return { stored: true };
  }

  /** Device reads the exact node-signed payload to verify and render. */
  getRequest(p: Principal, host: string, requestId: string) {
    if (p.kind !== 'device') throw new HubError(403, 'device-only');
    const r = this.one('SELECT payload, signature FROM requests WHERE host = ? AND request_id = ?', host, requestId);
    if (!r) throw new HubError(404, 'no-such-request');
    const node = this.one('SELECT node_id, spki FROM nodes WHERE host = ? AND revoked_at IS NULL', host);
    const decided = this.one('SELECT decision FROM decisions2 WHERE host = ? AND request_id = ? AND key_id = ?', host, requestId, p.id);
    return { payload: r.payload, signature: r.signature, node_id: node?.node_id, decision: decided?.decision ?? null };
  }

  /** Device lists what is waiting (unexpired, undecided), newest first. */
  pending(p: Principal) {
    if (p.kind !== 'device') throw new HubError(403, 'device-only');
    return this.all(`SELECT r.host, r.request_id, r.tier, r.description, r.expires_at FROM requests r
      LEFT JOIN decisions2 d ON d.host = r.host AND d.request_id = r.request_id AND d.key_id = ?
      JOIN nodes n ON n.host = r.host AND n.revoked_at IS NULL
      WHERE d.request_id IS NULL AND r.expires_at > ? ORDER BY r.received_at DESC LIMIT 50`, p.id, this.now());
  }

  // ── device: submit a signed decision ────────────────────────────────────────
  async submitDecision(p: Principal, message: string, signature: string): Promise<{ seq: number }> {
    if (p.kind !== 'device') throw new HubError(403, 'device-only');
    const dev = this.one('SELECT spki, decision_spki, biometric FROM devices WHERE device_id = ? AND revoked_at IS NULL', p.id);
    if (!dev || !dev.decision_spki || Number(dev.biometric) !== 1) throw new HubError(403, 'device-not-biometric');
    if (!(await verifyP256(String(dev.decision_spki), signature, message))) throw new HubError(400, 'bad-decision-signature');
    let m: Record<string, unknown>;
    try { m = JSON.parse(message); } catch { throw new HubError(400, 'message-not-json'); }
    if (canonical(m) !== message) throw new HubError(400, 'message-not-canonical');
    const req = this.one('SELECT fp, tier, nonce, expires_at, payload FROM requests WHERE host = ? AND request_id = ?', m.host, m.request_id);
    if (!req) throw new HubError(404, 'no-such-request');
    // Review H5: only approver keys the Mac itself listed in its signed request may decide it.
    const approvers = (JSON.parse(String(req.payload)).approver_key_ids ?? null) as string[] | null;
    if (!Array.isArray(approvers) || !approvers.includes(p.id)) throw new HubError(403, 'not-an-approver-for-this-request');
    if (m.v !== 1 || m.fp !== req.fp || m.nonce !== req.nonce || m.tier !== Number(req.tier) || m.expires_at !== Number(req.expires_at) ||
        !['approve', 'deny'].includes(String(m.decision)) || !Number.isInteger(m.issued_at))
      throw new HubError(400, 'decision-does-not-match-request');
    if (Math.abs(this.now() - Number(m.issued_at)) > MAX_ISSUED_SKEW_S) throw new HubError(400, 'decision-clock-skew');
    if (Number(req.expires_at) <= this.now()) throw new HubError(410, 'request-expired');
    if (this.one('SELECT 1 AS x FROM decisions2 WHERE host = ? AND request_id = ? AND key_id = ?', m.host, m.request_id, p.id))
      throw new HubError(409, 'already-decided');
    const seq = this.next('decision_seq');
    this.sql.exec(`INSERT INTO decisions2 (host, request_id, key_id, message, signature, decision, received_at, seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, m.host, m.request_id, p.id, message, signature, m.decision, this.now(), seq);
    this.event(p.id, 'decision.' + m.decision, { host: m.host, request_id: m.request_id });
    return { seq };
  }

  /** Device registers (or rotates) its APNs token. Device-signed, so only the enrolled phone can redirect its pushes. */
  setPushToken(p: Principal, token: string, env: string): void {
    if (p.kind !== 'device') throw new HubError(403, 'device-only');
    if (!/^[0-9a-f]{32,200}$/.test(token) || !['sandbox', 'production'].includes(env)) throw new HubError(400, 'invalid-push-token');
    this.sql.exec('UPDATE devices SET apns_token = ?, apns_env = ? WHERE device_id = ?', token, env, p.id);
    this.event(p.id, 'device.push-token', { env });
  }

  /** Node polls decisions for its own host after a sequence number. */
  decisionsFor(p: Principal, after: number) {
    if (p.kind !== 'node') throw new HubError(403, 'node-only');
    return this.all(`SELECT request_id, message, signature, key_id, seq FROM decisions2
      WHERE host = ? AND seq > ? ORDER BY seq LIMIT 20`, p.host, after);
  }

  // ── node: append receipts (hash-chain linkage enforced, append-only) ─────────
  appendReceipts(p: Principal, entries: { seq: number; hash: string; prev: string; [k: string]: unknown }[]) {
    if (p.kind !== 'node') throw new HubError(403, 'node-only');
    let last = this.one('SELECT seq, hash FROM receipts WHERE host = ? ORDER BY seq DESC LIMIT 1', p.host);
    let stored = 0;
    for (const e of entries) {
      if (!Number.isInteger(e.seq) || !HEX64.test(String(e.hash)) || typeof e.prev !== 'string') throw new HubError(400, 'invalid-receipt');
      if (last && e.seq <= Number(last.seq)) continue; // already mirrored
      if (last && (e.seq !== Number(last.seq) + 1 || e.prev !== last.hash)) throw new HubError(409, 'receipt-chain-break');
      this.sql.exec('INSERT INTO receipts (host, seq, hash, prev, entry, received_at) VALUES (?, ?, ?, ?, ?, ?)',
        p.host, e.seq, e.hash, e.prev, JSON.stringify(e), this.now());
      last = { seq: e.seq, hash: e.hash };
      stored++;
    }
    return { stored, head: last ?? null };
  }

  /** Owner (operator) view of a host's mirrored receipt chain, newest first. */
  receiptsFor(host: string, limit = 50) {
    if (!ID.test(host)) throw new HubError(400, 'invalid-host');
    return this.all('SELECT seq, hash, entry FROM receipts WHERE host = ? ORDER BY seq DESC LIMIT ?', host, Math.min(Math.max(limit, 1), 500))
      .map(r => ({ seq: r.seq, hash: r.hash, entry: JSON.parse(String(r.entry)) }));
  }

  // ── feed (lane cards, events) ───────────────────────────────────────────────
  postEvent(source: string, kind: string, body: unknown): void {
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(kind)) throw new HubError(400, 'invalid-kind');
    this.event(source, kind, body);
  }
  feed(p: Principal, after: number) {
    if (p.kind !== 'device') throw new HubError(403, 'device-only');
    return {
      events: this.all('SELECT id, at, source, kind, body FROM events WHERE id > ? ORDER BY id DESC LIMIT 100', after),
      pending: this.pending(p),
      nodes: this.all('SELECT node_id, host, spki FROM nodes WHERE revoked_at IS NULL'),
    };
  }
}
