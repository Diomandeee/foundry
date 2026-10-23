// APNs push for staged approval requests. The push is untrusted transport: it only
// wakes the Fabric app, which then fetches the node-signed request and verifies it.
import { apnsJwt } from './crypto';
import type { PushPort } from './hub';

export interface ApnsConfig { p8: string; keyId: string; teamId: string; topic: string }

export function apnsPush(cfg: ApnsConfig | null, now: () => number): PushPort {
  let cached: { token: string; at: number } | null = null;
  return {
    async notifyRequest(devices, req) {
      if (!cfg) return; // APNs not configured yet (owner step): events still record the request
      const nowSec = now();
      if (!cached || nowSec - cached.at > 2400) cached = { token: await apnsJwt(cfg.p8, cfg.keyId, cfg.teamId, nowSec), at: nowSec };
      const body = JSON.stringify({
        aps: { alert: { title: `Approve on ${req.host}`, body: req.description.slice(0, 160) || req.request_id },
               sound: 'default', category: 'FLEET_APPROVAL', 'interruption-level': req.tier >= 3 ? 'time-sensitive' : 'active' },
        host: req.host, request_id: req.request_id, tier: req.tier,
      });
      await Promise.all(devices.map(async d => {
        const base = d.apns_env === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
        const res = await fetch(`${base}/3/device/${d.apns_token}`, {
          method: 'POST', body,
          headers: { authorization: `bearer ${cached!.token}`, 'apns-topic': cfg.topic, 'apns-push-type': 'alert',
                     'apns-priority': '10', 'apns-expiration': '0' },
        });
        if (!res.ok) throw new Error(`apns ${res.status} ${await res.text()}`);
      }));
    },
  };
}
