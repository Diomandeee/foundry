// Test stand-in for the Fabric phone: P-256 key, signed HTTP, verify node payload, sign decision.
import { webcrypto as c } from 'node:crypto';
import fs from 'node:fs';
const [, , cmd, ...a] = process.argv;
const BASE = process.env.RELAY, DIR = process.env.DEVDIR, enc = new TextEncoder();
const b64 = b => Buffer.from(b).toString('base64');
const hex = async s => Buffer.from(await c.subtle.digest('SHA-256', typeof s === 'string' ? enc.encode(s) : s)).toString('hex');
const canonical = v => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
  : '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
function rawToDer(raw) { const int = b => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; let v = b.slice(i); if (v[0] & 0x80) v = Uint8Array.from([0, ...v]); return Uint8Array.from([2, v.length, ...v]); };
  const r = int(raw.slice(0, 32)), s = int(raw.slice(32)); return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]); }
function derToRaw(sig) { if (sig.length === 64) return sig; let i = 2; const out = new Uint8Array(64);
  for (const off of [0, 32]) { const len = sig[i + 1]; let n = sig.slice(i + 2, i + 2 + len); while (n.length > 32 && n[0] === 0) n = n.slice(1); out.set(n, off + 32 - n.length); i += 2 + len; } return out; }
async function key() { return c.subtle.importKey('pkcs8', fs.readFileSync(DIR + '/device.pk8'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']); }
async function sign(s) { return b64(rawToDer(new Uint8Array(await c.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await key(), enc.encode(s))))); }
async function call(method, path, bodyObj) {
  const body = bodyObj ? JSON.stringify(bodyObj) : ''; const ts = String(Math.floor(Date.now() / 1000));
  const sig = await sign(`${method}\n${path}\n${ts}\n${await hex(body)}`);
  const r = await fetch(BASE + path, { method, body: body || undefined, headers: { 'x-fs-key': a[0], 'x-fs-ts': ts, 'x-fs-sig': sig, 'content-type': 'application/json' } });
  return { status: r.status, json: await r.json() };
}
if (cmd === 'keygen') {
  const k = await c.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  fs.writeFileSync(DIR + '/device.pk8', Buffer.from(await c.subtle.exportKey('pkcs8', k.privateKey)), { mode: 0o600 });
  console.log(b64(await c.subtle.exportKey('spki', k.publicKey)));
} else if (cmd === 'pending') {
  console.log(JSON.stringify(await call('GET', '/v1/pending')));
} else if (cmd === 'decide') { // decide <device-id> <host> <request-id> <approve|deny> <expected-node-spki>
  const [dev, host, rid, decision, nodeSpki] = a;
  const g = await call('GET', `/v1/requests/${host}/${rid}`);
  if (g.status !== 200) { console.log('get failed', JSON.stringify(g)); process.exit(1); }
  const pub = await c.subtle.importKey('spki', Buffer.from(nodeSpki, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await c.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, derToRaw(new Uint8Array(Buffer.from(g.json.signature, 'base64'))), enc.encode(g.json.payload));
  const p = JSON.parse(g.json.payload);
  const fpo = { host: p.host, script: p.script, args: p.args, run_as: p.run_as, timeout_s: p.timeout_s, template: p.template };
  const att = p.attachments ?? {};
  for (const [n, a] of Object.entries(att)) if (a.text !== undefined && (await hex(a.text)) !== a.sha256) { console.log('attachment text/hash mismatch', n); process.exit(2); }
  if (Object.keys(att).length) fpo.attachments = Object.fromEntries(Object.entries(att).map(([n, a]) => [n, a.sha256]));
  const fp = await hex(canonical(fpo));
  console.log('node signature valid:', ok, '| fp recomputed matches:', fp === p.fp, '| script sha matches:', (await hex(p.script)) === p.script_sha256);
  console.log('script the phone shows:\n----\n' + p.script + '----');
  if (!ok || fp !== p.fp) process.exit(2);
  const msg = canonical({ v: 1, host, request_id: rid, fp: p.fp, tier: p.tier, nonce: p.nonce, expires_at: p.expires_at, issued_at: Math.floor(Date.now() / 1000), decision });
  console.log('submit:', JSON.stringify(await call('POST', '/v1/decisions', { message: msg, signature: await sign(msg) })));
}
