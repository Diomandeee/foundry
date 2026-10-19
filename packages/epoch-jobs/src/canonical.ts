/** Bounded JSON data only. Proxies are outside the boundary; callers supply parsed JSON. */
export function canonical(value: unknown): string {
  let nodes = 0, budget = 65536;
  const active = new Set<object>();
  function debit(n: number) { budget -= n; if (budget < 0) throw new Error('JSON byte limit'); }
  function visit(v: unknown, depth: number): string {
    if (++nodes > 8192 || depth > 32) throw new Error('JSON complexity');
    if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') {
      if (typeof v === 'number' && (!Number.isFinite(v) || Object.is(v, -0))) throw new Error('nonfinite or negative zero JSON');
      if (typeof v === 'string' && v.length > 65536) throw new Error('JSON string limit');
      const s = JSON.stringify(v); debit(new TextEncoder().encode(s).length); return s;
    }
    if (typeof v !== 'object' || !v || active.has(v)) throw new Error('invalid JSON');
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new Error('JSON prototype');
    const keys = Reflect.ownKeys(v);
    if (keys.length > 8193) throw new Error('JSON properties');
    const ds = Object.getOwnPropertyDescriptors(v);
    for (const k of keys) {
      if (typeof k !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(k)) throw new Error('unsafe JSON key');
      if (!('value' in ds[k]) || (!ds[k].enumerable && !(array && k === 'length'))) throw new Error('active or hidden JSON');
    }
    active.add(v); debit(2);
    let result: string;
    if (array) {
      const n = ds.length.value as number;
      if (n > 8192 || keys.length !== n + 1) throw new Error('decorated or sparse array');
      const items: string[] = [];
      for (let i = 0; i < n; i++) {
        if (!Object.hasOwn(ds, String(i))) throw new Error('sparse array');
        if (i) debit(1); items.push(visit(ds[String(i)].value, depth + 1));
      }
      result = '[' + items.join(',') + ']';
    } else {
      const items: string[] = [];
      for (const k of (keys as string[]).sort()) {
        if (k.length > 65536) throw new Error('JSON key limit');
        const key = JSON.stringify(k); debit(new TextEncoder().encode(key).length + 1 + (items.length ? 1 : 0));
        items.push(key + ':' + visit(ds[k].value, depth + 1));
      }
      result = '{' + items.join(',') + '}';
    }
    active.delete(v); return result;
  }
  return visit(value, 0);
}
