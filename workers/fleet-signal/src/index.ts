// fleet-signal Worker: HTTP front door + one Durable Object (SQLite) per environment.
//
// Auth
//  - Owner (admin + fleet-watch events): `Authorization: Bearer <token>`, checked
//    against FLEET_SIGNAL_OWNER_SHA256 (digest only; the token never leaves Mac1).
//  - Nodes (Mac daemons) and devices (Fabric app): P-256 signed requests:
//    headers x-fs-key, x-fs-ts, x-fs-sig over "METHOD\nPATH?QUERY\nTS\nsha256(body)".
//
// Routes
//  GET  /v1/health
//  POST /v1/admin/nodes      {node_id, host, spki}                     owner
//  POST /v1/admin/devices    {device_id, spki, decision_spki?, label?, apns_token?, apns_env?}  owner
//  POST /v1/devices/push     {token, env}                              device
//  POST /v1/admin/revoke     {kind: node|device, id}                   owner
//  POST /v1/events           {kind, body}                              owner or node
//  POST /v1/requests         {payload, signature}                      node
//  GET  /v1/requests/:host/:id                                         device
//  GET  /v1/pending                                                    device
//  POST /v1/decisions        {message, signature}                      device
//  GET  /v1/decisions?after=N                                          node
//  POST /v1/receipts         {entries:[...]}                           node
//  GET  /v1/feed?after=N                                               device
import { DurableObject } from 'cloudflare:workers';
import { apnsPush } from './apns';
import { sha256Hex } from './crypto';
import { HubError, SignalHub, type Principal } from './hub';

export interface Env {
  HUB: DurableObjectNamespace<SignalHubObject>;
  FLEET_SIGNAL_OWNER_SHA256: string;
  FLEET_SIGNAL_ENVIRONMENT: string;
  APNS_KEY_P8?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export class SignalHubObject extends DurableObject<Env> {
  private hub: SignalHub;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = { exec: (q: string, ...b: unknown[]) => ctx.storage.sql.exec(q, ...b).toArray() as Record<string, unknown>[] };
    const now = () => Math.floor(Date.now() / 1000);
    const apns = env.APNS_KEY_P8 && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_TOPIC
      ? { p8: env.APNS_KEY_P8, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, topic: env.APNS_TOPIC } : null;
    this.hub = new SignalHub(sql, now, apnsPush(apns, now));
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname, pq = url.pathname + url.search;
    const body = req.method === 'GET' ? '' : await req.text();
    if (body.length > 256 * 1024) return json(413, { error: 'body-too-large' });
    const data = body ? JSON.parse(body) : {};
    try {
      const auth = req.headers.get('authorization') ?? '';
      const isOwner = auth.startsWith('Bearer ') &&
        (await sha256Hex(auth.slice(7))) === this.env.FLEET_SIGNAL_OWNER_SHA256;
      if (path.startsWith('/v1/admin/')) {
        if (!isOwner) return json(401, { error: 'owner-only' });
        if (path === '/v1/admin/nodes') this.hub.enrollNode(data.node_id, data.host, data.spki);
        else if (path === '/v1/admin/devices') this.hub.enrollDevice(data.device_id, data.spki, data.label ?? null, data.apns_token ?? null, data.apns_env ?? null, data.decision_spki ?? null, data.biometric === true);
        else if (path === '/v1/admin/revoke') this.hub.revoke(data.kind, data.id);
        else return json(404, { error: 'not-found' });
        return json(200, { ok: true });
      }
      if (path === '/v1/events' && isOwner) {
        this.hub.postEvent('owner', data.kind, data.body ?? {});
        return json(200, { ok: true });
      }
      const p: Principal = await this.hub.authenticate({
        keyId: req.headers.get('x-fs-key') ?? '', ts: req.headers.get('x-fs-ts') ?? '', signature: req.headers.get('x-fs-sig') ?? '',
      }, req.method, pq, body);
      const m = path.match(/^\/v1\/requests\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/);
      if (req.method === 'POST' && path === '/v1/requests') return json(200, await this.hub.publishRequest(p, data.payload, data.signature));
      if (req.method === 'GET' && m) return json(200, this.hub.getRequest(p, m[1], m[2]));
      if (req.method === 'GET' && path === '/v1/pending') return json(200, { pending: this.hub.pending(p) });
      if (req.method === 'POST' && path === '/v1/decisions') return json(200, await this.hub.submitDecision(p, data.message, data.signature));
      if (req.method === 'GET' && path === '/v1/decisions') return json(200, { decisions: this.hub.decisionsFor(p, Number(url.searchParams.get('after') ?? 0)) });
      if (req.method === 'POST' && path === '/v1/receipts') return json(200, this.hub.appendReceipts(p, data.entries ?? []));
      if (req.method === 'POST' && path === '/v1/devices/push') { this.hub.setPushToken(p, data.token, data.env); return json(200, { ok: true }); }
      if (req.method === 'GET' && path === '/v1/feed') return json(200, this.hub.feed(p, Number(url.searchParams.get('after') ?? 0)));
      if (req.method === 'POST' && path === '/v1/events' && p.kind === 'node') {
        this.hub.postEvent(p.id, data.kind, data.body ?? {});
        return json(200, { ok: true });
      }
      return json(404, { error: 'not-found' });
    } catch (e) {
      if (e instanceof HubError) return json(e.status, { error: e.code });
      return json(500, { error: 'internal' });
    }
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/v1/health') return json(200, { ok: true, service: 'fleet-signal', environment: env.FLEET_SIGNAL_ENVIRONMENT });
    if (!url.pathname.startsWith('/v1/')) return json(404, { error: 'not-found' });
    const stub = env.HUB.get(env.HUB.idFromName('fleet'));
    return stub.handle(req);
  },
};
