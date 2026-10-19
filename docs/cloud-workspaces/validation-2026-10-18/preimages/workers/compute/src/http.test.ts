import { afterEach, describe, expect, it, vi } from 'vitest';
import { boundedJson } from './http';

const encode = (value: string) => new TextEncoder().encode(value);
function request(source: UnderlyingSource<Uint8Array>) {
  return new Request('https://local.invalid', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: new ReadableStream(source), duplex: 'half',
  } as RequestInit);
}
afterEach(() => { vi.useRealTimers(); });

describe('bounded JSON bodies', () => {
  it('ignores empty chunks and accepts one-byte chunks at the exact byte limit', async () => {
    const input = encode('{"value":"é"}');
    const req = request({ start(controller) {
      for (const byte of input) {
        controller.enqueue(new Uint8Array());
        controller.enqueue(new Uint8Array([byte]));
      }
      controller.close();
    } });
    await expect(boundedJson(req, input.length)).resolves.toEqual({ value: 'é' });
    expect(req.body!.locked).toBe(false);
  });

  it('rejects empty and malformed JSON bodies', async () => {
    for (const data of [new Uint8Array(), encode('{'), new Uint8Array([255])]) {
      await expect(boundedJson(request({ start(c) { c.enqueue(data); c.close(); } }), 16))
        .rejects.toMatchObject({ status: 400, code: 'invalid-json' });
    }
  });

  it('rejects oversized input without awaiting a hanging cancellation', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const req = request({ start(c) { c.enqueue(encode('12345')); }, cancel });
    await expect(boundedJson(req, 4)).rejects.toMatchObject({ status: 413, code: 'request-too-large' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(req.body!.locked).toBe(false);
  });

  it('caps endless empty reads even while timers cannot run', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const req = request({ pull(c) { c.enqueue(new Uint8Array()); }, cancel });
    await expect(boundedJson(req, 16)).rejects.toMatchObject({ status: 413, code: 'request-too-many-chunks' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a stalled read and does not await cancellation', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const req = request({ cancel });
    const result = expect(boundedJson(req, 16, 20)).rejects.toMatchObject({ status: 408, code: 'request-timeout' });
    await vi.advanceTimersByTimeAsync(20);
    await result;
    expect(cancel).toHaveBeenCalledOnce();
    expect(req.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses an absolute deadline rather than resetting it for each chunk', async () => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const req = request({ start(c) { controller = c; } });
    const result = expect(boundedJson(req, 16, 20)).rejects.toMatchObject({ status: 408 });
    await vi.advanceTimersByTimeAsync(15);
    controller.enqueue(encode('['));
    await vi.advanceTimersByTimeAsync(5);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline on success and handles cancellation rejection', async () => {
    vi.useFakeTimers();
    await expect(boundedJson(request({ start(c) { c.enqueue(encode('{}')); c.close(); } }), 16)).resolves.toEqual({});
    expect(vi.getTimerCount()).toBe(0);
    await expect(boundedJson(request({
      start(c) { c.enqueue(encode('12345')); },
      cancel() { return Promise.reject(new Error('cancel failed')); },
    }), 4)).rejects.toMatchObject({ status: 413 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
