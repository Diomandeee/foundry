import {constants} from 'node:fs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Mock only the OS boundary: the real census parser, validation and bounded
// reopen loop run unchanged. No /run access, helper, mount or broker connection.
const fs = vi.hoisted(() => ({open: vi.fn(), lstat: vi.fn()}));
vi.mock('node:fs/promises', () => fs);
import {readLinuxIsolationCensus, type LinuxIsolationCensus} from './linux-isolated-census.js';

const now = 1800000000000;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const census = (): LinuxIsolationCensus => ({version: 1, observedAt: now, freeBytes: 123456,
  workspaceBytes: 789, complete: true, slotFree: false, profiles: ['a'.repeat(64)],
  helperSha256: 'b'.repeat(64), pythonSha256: 'c'.repeat(64)});
const directory = () => ({isDirectory: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o755});
function descriptor(bytes = Buffer.from(JSON.stringify(census())), statOverride: Record<string, unknown> = {}) {
  return {
    stat: vi.fn(async () => ({isFile: () => true, uid: 0, nlink: 1, mode: 0o444, size: bytes.length, ...statOverride})),
    read: vi.fn(async (target: Buffer, offset: number, length: number, position: number) => {
      const bytesRead = bytes.copy(target, offset, position, position + length);
      return {bytesRead, buffer: target};
    }),
    close: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  fs.open.mockReset(); fs.lstat.mockReset();
  fs.open.mockRejectedValue(new Error('unexpected-extra-open'));
  fs.lstat.mockResolvedValue(directory());
  Object.defineProperty(process, 'platform', {...platform, value: 'linux'});
  vi.spyOn(Date, 'now').mockReturnValue(now);
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks();
});

describe('Linux census atomic replacement and resource bounds', () => {
  it('opens only the root-owned namespace and reads one bounded descriptor', async () => {
    const fd = descriptor(); fs.open.mockResolvedValueOnce(fd);
    await expect(readLinuxIsolationCensus()).resolves.toEqual(census());
    expect(fs.lstat.mock.calls).toEqual([['/run'], ['/run/foundry-linux']]);
    expect(fs.open).toHaveBeenCalledExactlyOnceWith('/run/foundry-linux/census.json', constants.O_RDONLY | constants.O_NOFOLLOW);
    expect(fd.read).toHaveBeenCalledExactlyOnceWith(expect.any(Buffer), 0, 4097, 0);
    expect(fd.read.mock.calls[0]![0]).toHaveLength(4097);
    expect(fd.close).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2])('reopens after %i unlinked inode(s) and returns the replacement', async replacements => {
    const stale = Array.from({length: replacements}, () => descriptor(Buffer.from('stale'), {nlink: 0}));
    const replacement = census(); replacement.workspaceBytes = 4567;
    const live = descriptor(Buffer.from(JSON.stringify(replacement)));
    for (const fd of stale) fs.open.mockResolvedValueOnce(fd);
    fs.open.mockResolvedValueOnce(live);
    await expect(readLinuxIsolationCensus()).resolves.toEqual(replacement);
    expect(fs.open).toHaveBeenCalledTimes(replacements + 1);
    for (const fd of stale) {expect(fd.read).not.toHaveBeenCalled(); expect(fd.close).toHaveBeenCalledTimes(1);}
    expect(live.close).toHaveBeenCalledTimes(1);
    const handles = [...stale, live];
    for (let i = 0; i < replacements; i++) {
      expect(handles[i]!.close.mock.invocationCallOrder[0]).toBeLessThan(fs.open.mock.invocationCallOrder[i + 1]!);
    }
  });

  it('stops at exactly three replacements, closes all handles and never reads stale bytes', async () => {
    const handles = Array.from({length: 3}, () => descriptor(Buffer.from('old'), {nlink: 0}));
    for (const fd of handles) fs.open.mockResolvedValueOnce(fd);
    await expect(readLinuxIsolationCensus()).rejects.toThrow('linux-census-replacement-budget');
    expect(fs.open).toHaveBeenCalledTimes(3);
    for (const fd of handles) {expect(fd.close).toHaveBeenCalledTimes(1); expect(fd.read).not.toHaveBeenCalled();}
  });

  it.each([
    ['hard linked', {nlink: 2}], ['not root-owned', {uid: 1000}], ['writable', {mode: 0o644}],
    ['not regular', {isFile: () => false}], ['empty', {size: 0}], ['oversized', {size: 4097}],
  ])('rejects a %s file without retry or read', async (_name, override) => {
    const fd = descriptor(undefined, override as Record<string, unknown>); fs.open.mockResolvedValueOnce(fd);
    await expect(readLinuxIsolationCensus()).rejects.toThrow('linux-census-file');
    expect(fs.open).toHaveBeenCalledTimes(1); expect(fd.read).not.toHaveBeenCalled(); expect(fd.close).toHaveBeenCalledTimes(1);
  });

  it.each([-1, 1])('rejects descriptor/read size drift of %i byte(s)', async delta => {
    const bytes = Buffer.from(JSON.stringify(census())), fd = descriptor(bytes, {size: bytes.length + delta});
    fs.open.mockResolvedValueOnce(fd);
    await expect(readLinuxIsolationCensus()).rejects.toThrow('linux-census-size');
    expect(fs.open).toHaveBeenCalledTimes(1); expect(fd.close).toHaveBeenCalledTimes(1);
  });

  it.each(['stat', 'read'] as const)('closes the descriptor when %s fails', async method => {
    const fd = descriptor(); fd[method].mockRejectedValueOnce(new Error('fake-io-failure')); fs.open.mockResolvedValueOnce(fd);
    await expect(readLinuxIsolationCensus()).rejects.toThrow('fake-io-failure');
    expect(fd.close).toHaveBeenCalledTimes(1); expect(fs.open).toHaveBeenCalledTimes(1);
  });

  it('propagates an unavailable census instead of reporting zero', async () => {
    fs.open.mockRejectedValueOnce(new Error('fake-permission-denied'));
    await expect(readLinuxIsolationCensus()).rejects.toThrow('fake-permission-denied'); expect(fs.open).toHaveBeenCalledTimes(1);
  });
});

describe('Linux census namespace, freshness and accounting validation', () => {
  it('rejects non-Linux hosts before filesystem access', async () => {
    Object.defineProperty(process, 'platform', {...platform, value: 'darwin'});
    await expect(readLinuxIsolationCensus()).rejects.toThrow('linux-census-platform');
    expect(fs.lstat).not.toHaveBeenCalled(); expect(fs.open).not.toHaveBeenCalled();
  });

  it.each([
    ['symlink', {isSymbolicLink: () => true}], ['writable', {mode: 0o775}],
    ['foreign owner', {uid: 1000}], ['not directory', {isDirectory: () => false}],
  ])('rejects a %s ancestor before opening the census', async (_name, override) => {
    fs.lstat.mockResolvedValueOnce(directory()).mockResolvedValueOnce({...directory(), ...override});
    await expect(readLinuxIsolationCensus()).rejects.toThrow('linux-census-namespace'); expect(fs.open).not.toHaveBeenCalled();
  });

  it.each([
    ['stale', {observedAt: now - 15001}, 'linux-census-freshness'],
    ['future', {observedAt: now + 1}, 'linux-census-freshness'],
    ['fractional timestamp', {observedAt: now - 0.5}, 'linux-census-freshness'],
    ['negative free space', {freeBytes: -1}, 'linux-census-freshness'],
    ['unsafe free space', {freeBytes: Number.MAX_SAFE_INTEGER + 1}, 'linux-census-freshness'],
    ['unknown complete accounting', {workspaceBytes: null}, 'linux-census-accounting'],
    ['numeric incomplete accounting', {complete: false}, 'linux-census-accounting'],
    ['negative accounting', {workspaceBytes: -1}, 'linux-census-accounting'],
    ['duplicate profiles', {profiles: ['a'.repeat(64), 'a'.repeat(64)]}, 'linux-census-installed-policy'],
    ['no profiles', {profiles: []}, 'linux-census-installed-policy'],
    ['too many profiles', {profiles: Array.from({length: 33}, (_, i) => i.toString(16).padStart(64, '0'))}, 'linux-census-installed-policy'],
    ['invalid installed hash', {helperSha256: 'unverified'}, 'linux-census-installed-policy'],
    ['unsupported version', {version: 2}, 'linux-census-shape'],
    ['nonboolean slot', {slotFree: 1}, 'linux-census-shape'],
    ['extra field', {unexpected: true}, 'linux-census-shape'],
  ])('rejects %s and closes the descriptor', async (_name, override, error) => {
    const fd = descriptor(Buffer.from(JSON.stringify({...census(), ...override}))); fs.open.mockResolvedValueOnce(fd);
    await expect(readLinuxIsolationCensus()).rejects.toThrow(error as string);
    expect(fd.close).toHaveBeenCalledTimes(1); expect(fs.open).toHaveBeenCalledTimes(1);
  });

  it('preserves unknown/incomplete workspace accounting as null', async () => {
    const unknown = {...census(), workspaceBytes: null, complete: false};
    fs.open.mockResolvedValueOnce(descriptor(Buffer.from(JSON.stringify(unknown))));
    await expect(readLinuxIsolationCensus()).resolves.toEqual(unknown);
  });
  it('accepts the exact freshness boundary and measured zero bytes', async () => {
    const boundary = {...census(), observedAt: now - 15000, workspaceBytes: 0, freeBytes: 0};
    fs.open.mockResolvedValueOnce(descriptor(Buffer.from(JSON.stringify(boundary))));
    await expect(readLinuxIsolationCensus()).resolves.toEqual(boundary);
  });
  it.each([Buffer.from('{invalid'), Buffer.from([0xff])])('rejects malformed JSON or UTF-8 and closes the descriptor', async bytes => {
    const fd = descriptor(bytes); fs.open.mockResolvedValueOnce(fd);
    await expect(readLinuxIsolationCensus()).rejects.toThrow(); expect(fd.close).toHaveBeenCalledTimes(1);
    expect(fs.open).toHaveBeenCalledTimes(1);
  });
});
