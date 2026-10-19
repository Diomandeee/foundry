import { createHash } from 'node:crypto';
import { types } from 'node:util';

export function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`library-jobs: ${message}`);
}
/** Bounded inert JSON only. No getters, proxies, toJSON, symbols or inherited data. */
export function canonical(value: unknown): string {
  let nodes = 0, remaining = 262144;
  const active = new Set<object>();
  function debit(n: number) { remaining -= n; check(remaining >= 0, 'JSON byte budget'); }
  function visit(v: unknown, depth: number): string {
    check(++nodes <= 16384 && depth <= 16, 'JSON complexity budget');
    if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') {
      if (typeof v === 'number') check(Number.isFinite(v) && !Object.is(v, -0), 'invalid JSON number');
      if (typeof v === 'string') check(v.length <= 262144, 'JSON string budget');
      const text = JSON.stringify(v); debit(Buffer.byteLength(text)); return text;
    }
    check(typeof v === 'object' && v !== null && !types.isProxy(v) && !active.has(v), 'non-inert JSON');
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    check(array ? proto === Array.prototype : proto === Object.prototype || proto === null, 'JSON prototype');
    const keys = Reflect.ownKeys(v);
    check(keys.length <= 4096, 'JSON property budget');
    const descriptors = Object.getOwnPropertyDescriptors(v);
    for (const key of keys) {
      check(typeof key === 'string' && !['__proto__', 'prototype', 'constructor'].includes(key), 'unsafe key');
      const descriptor = descriptors[key];
      check('value' in descriptor && (descriptor.enumerable || (array && key === 'length')), 'accessor or hidden field');
    }
    active.add(v); debit(2);
    let text: string;
    if (array) {
      const length = descriptors.length.value as number;
      check(length <= 4095 && keys.length === length + 1, 'sparse or decorated array');
      const items: string[] = [];
      for (let i = 0; i < length; i++) {
        check(Object.hasOwn(descriptors, String(i)), 'sparse array');
        if (i) debit(1);
        items.push(visit(descriptors[String(i)].value, depth + 1));
      }
      text = '[' + items.join(',') + ']';
    } else {
      const items: string[] = [];
      for (const key of (keys as string[]).sort()) {
        check(key.length <= 256, 'JSON key budget');
        const encoded = JSON.stringify(key); debit(Buffer.byteLength(encoded) + 1 + (items.length ? 1 : 0));
        items.push(encoded + ':' + visit(descriptors[key].value, depth + 1));
      }
      text = '{' + items.join(',') + '}';
    }
    active.delete(v); return text;
  }
  return visit(value, 0);
}
export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const identity = (domain: string, value: unknown): string => sha256(domain + '\n' + canonical(value));
export function snapshot(value: unknown): unknown { return JSON.parse(canonical(value)); }
export function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
export function record(value: unknown, names: readonly string[]): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected record');
  check(Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key)), 'unknown or missing fields');
}
export function integer(value: unknown, max = Number.MAX_SAFE_INTEGER, min = 0): asserts value is number {
  check(typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min && value <= max, 'integer out of bounds');
}
export function identifier(value: unknown): asserts value is string {
  check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}(?![\s\S])/.test(value), 'invalid reference identifier');
}
export function hash(value: unknown): asserts value is string {
  check(typeof value === 'string' && /^[0-9a-f]{64}(?![\s\S])/.test(value), 'invalid sha256');
}
/** Copy native byte views without invoking caller properties or species constructors. */
export function boundedBytes(value: unknown, max: number): Uint8Array {
  check(typeof value === 'object' && value !== null && !types.isProxy(value) && types.isUint8Array(value), 'expected native bytes');
  const proto = Object.getPrototypeOf(Uint8Array.prototype);
  const length = Object.getOwnPropertyDescriptor(proto, 'byteLength')!.get!.call(value) as number;
  const buffer = Object.getOwnPropertyDescriptor(proto, 'buffer')!.get!.call(value);
  check(!types.isSharedArrayBuffer(buffer), 'shared byte buffer');
  check(length <= max, 'read byte budget');
  const copy = new Uint8Array(length);
  Uint8Array.prototype.set.call(copy, value);
  return copy;
}
/** Envelope permits native bytes but still never invokes accessors or proxy traps. */
export function readResult(value: unknown): { ref: unknown; bytes: unknown } {
  check(typeof value === 'object' && value !== null && !types.isProxy(value), 'invalid read result');
  const proto = Object.getPrototypeOf(value);
  check(proto === Object.prototype || proto === null, 'read result prototype');
  const keys = Reflect.ownKeys(value);
  check(keys.length === 2 && keys.includes('ref') && keys.includes('bytes'), 'read result fields');
  const ds = Object.getOwnPropertyDescriptors(value);
  check(['ref', 'bytes'].every(key => 'value' in ds[key] && ds[key].enumerable), 'read result accessor');
  return { ref: ds.ref.value, bytes: ds.bytes.value };
}
