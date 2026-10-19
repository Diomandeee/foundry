import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { VerificationReceipt } from '../packages/stores/src/decisions';
import { recordLocalVerification } from './local-verification-store';

// Cleanup is restricted to roots returned by this test's own mkdtemp calls.
// No existing repository, receipt directory, or external target is removed.
const ownedRoots: string[] = [];
afterEach(async () => {
  for (const root of ownedRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

function receipt(): VerificationReceipt {
  const body: Omit<VerificationReceipt, 'sha256'> = {
    version: 1,
    request: {
      repo: 'fixture/repo', baseBranch: 'main', headSha: 'a'.repeat(40),
      files: ['src/example.ts'], namespace: 'local-fixture', ref: 'refs/heads/candidate',
      before: 'b'.repeat(40), baseSha: 'c'.repeat(40), contentHash: 'd'.repeat(64),
    },
    policy: { enforce: true, requireChecked: true },
    verdict: { checked: true, ok: true, runs: [{ name: 'fixture-check', ok: true }] },
  };
  return { ...body, sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

async function fixture(existingDirectory = false) {
  // Resolve the platform temporary path so the fixture parent itself is not
  // a macOS /var symlink; the helper intentionally rejects symlink parents.
  const root = await mkdtemp(join(await realpath(tmpdir()), 'foundry-local-receipt-test-'));
  ownedRoots.push(root);
  const directory = join(root, 'receipts');
  if (existingDirectory) await mkdir(directory, { mode: 0o700 });
  const value = receipt();
  const file = join(directory, `${value.sha256}.json`);
  return { root, directory, file, value, encoded: JSON.stringify(value) };
}

async function identity(path: string) {
  const stat = await lstat(path);
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink, uid: stat.uid, size: stat.size, mtimeMs: stat.mtimeMs };
}

describe('recordLocalVerification: actual local filesystem receipts', () => {
  it('creates a private receipt, closes/syncs it and permits independent exact-byte readback', async () => {
    const f = await fixture();
    await expect(recordLocalVerification(f.directory, f.value)).resolves.toBeUndefined();
    expect(await readdir(f.root)).toEqual(['receipts']);
    expect(await readdir(f.directory)).toEqual([`${f.value.sha256}.json`]);
    const directory = await lstat(f.directory), file = await lstat(f.file);
    expect(directory.isDirectory()).toBe(true);
    expect(directory.mode & 0o777).toBe(0o700);
    expect(file.isFile()).toBe(true);
    expect(file.isSymbolicLink()).toBe(false);
    expect(file.mode & 0o777).toBe(0o600);
    expect(file.nlink).toBe(1);
    expect(file.uid).toBe(process.getuid!());
    expect(file.size).toBe(Buffer.byteLength(f.encoded));
    const bytes = await readFile(f.file);
    expect(bytes).toEqual(Buffer.from(f.encoded));
    const decoded = new TextDecoder().decode(bytes);
    const { sha256, ...body } = JSON.parse(decoded) as VerificationReceipt;
    expect(sha256).toBe(createHash('sha256').update(JSON.stringify(body)).digest('hex'));
    expect(JSON.parse(decoded)).toEqual(f.value);
  });

  it('accepts an identical retry without replacing or rewriting the receipt or existing directory', async () => {
    const f = await fixture(true);
    const sentinel = join(f.directory, 'existing-evidence.txt');
    await writeFile(sentinel, 'retain unrelated evidence', { mode: 0o600, flag: 'wx' });
    const directory = await lstat(f.directory);
    await recordLocalVerification(f.directory, f.value);
    const before = await identity(f.file), sentinelBefore = await identity(sentinel);
    // A separately deserialized receipt exercises value equality, not object identity.
    await expect(recordLocalVerification(f.directory, JSON.parse(f.encoded))).resolves.toBeUndefined();
    expect(await identity(f.file)).toEqual(before);
    expect(await readFile(f.file, 'utf8')).toBe(f.encoded);
    expect(await identity(sentinel)).toEqual(sentinelBefore);
    expect(await readFile(sentinel, 'utf8')).toBe('retain unrelated evidence');
    expect((await lstat(f.directory)).ino).toBe(directory.ino);
    expect((await readdir(f.directory)).sort()).toEqual([`${f.value.sha256}.json`, 'existing-evidence.txt'].sort());
  });

  it('refuses same-length tampering and leaves the existing inode and bytes untouched on repeated retries', async () => {
    const f = await fixture(true);
    const corrupt = f.encoded.replace('fixture/repo', 'fixture/evil');
    expect(corrupt).not.toBe(f.encoded);
    expect(Buffer.byteLength(corrupt)).toBe(Buffer.byteLength(f.encoded));
    await writeFile(f.file, corrupt, { mode: 0o600, flag: 'wx' });
    const before = await identity(f.file);
    for (let retry = 0; retry < 2; retry++) {
      await expect(recordLocalVerification(f.directory, f.value)).rejects.toThrow('verification receipt not durably confirmed');
      expect(await identity(f.file)).toEqual(before);
      expect(await readFile(f.file, 'utf8')).toBe(corrupt);
    }
    expect(await readdir(f.directory)).toEqual([`${f.value.sha256}.json`]);
  });

  it('rejects malformed UTF-8 that decodes to the same replacement character without modifying evidence',async()=>{
    const f=await fixture(true),{sha256:oldDigest,...body}=f.value;
    body.verdict.runs[0]!.name='replacement-\uFFFD';
    const value={...body,sha256:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
    const encoded=JSON.stringify(value),corrupt=Buffer.from(encoded),offset=corrupt.indexOf(Buffer.from('\uFFFD'));
    expect(offset).toBeGreaterThan(0);corrupt.set([0xf1,0x80,0x80],offset);
    expect(corrupt.toString('utf8')).toBe(encoded);
    const file=join(f.directory,value.sha256+'.json');await writeFile(file,corrupt,{flag:'wx',mode:0o600});
    const before=await identity(file);
    await expect(recordLocalVerification(f.directory,value)).rejects.toThrow('verification receipt not durably confirmed');
    expect(await readFile(file)).toEqual(corrupt);expect(await identity(file)).toEqual(before);
  });

  it.each(['empty', 'truncated'] as const)('retains an %s partial receipt and refuses to heal it', async kind => {
    const f = await fixture(true);
    const partial = kind === 'empty' ? '' : f.encoded.slice(0, -1);
    await writeFile(f.file, partial, { mode: 0o600, flag: 'wx' });
    const before = await identity(f.file);
    await expect(recordLocalVerification(f.directory, f.value)).rejects.toThrow('verification receipt identity mismatch');
    expect(await identity(f.file)).toEqual(before);
    expect(await readFile(f.file, 'utf8')).toBe(partial);
    expect(await readdir(f.directory)).toEqual([`${f.value.sha256}.json`]);
  });

  it.each([false, true])('refuses an existing target symlink (dangling=%s) without following or replacing it', async dangling => {
    const f = await fixture(true), destination = join(f.root, 'symlink-destination.json');
    if (!dangling) await writeFile(destination, f.encoded, { mode: 0o600, flag: 'wx' });
    const destinationBefore = dangling ? null : await identity(destination);
    await symlink(destination, f.file);
    const before = await identity(f.file);
    // O_NOFOLLOW is a real OS operation; platform-specific errno is not the contract.
    await expect(recordLocalVerification(f.directory, f.value)).rejects.toThrow();
    expect(await identity(f.file)).toEqual(before);
    expect((await lstat(f.file)).isSymbolicLink()).toBe(true);
    expect(await readlink(f.file)).toBe(destination);
    if (dangling) await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    else {
      expect(await identity(destination)).toEqual(destinationBefore);
      expect(await readFile(destination, 'utf8')).toBe(f.encoded);
    }
    expect(await readdir(f.directory)).toEqual([`${f.value.sha256}.json`]);
  });

  it('refuses a hardlinked target even when its bytes and owner-only mode are otherwise correct', async () => {
    const f = await fixture(true), original = join(f.root, 'original-receipt.json');
    await writeFile(original, f.encoded, { mode: 0o600, flag: 'wx' });
    await link(original, f.file);
    const before = await identity(f.file);
    expect(before.nlink).toBe(2);
    expect((await lstat(original)).ino).toBe(before.ino);
    await expect(recordLocalVerification(f.directory, f.value)).rejects.toThrow('verification receipt identity mismatch');
    expect(await identity(f.file)).toEqual(before);
    expect(await identity(original)).toEqual(before);
    expect(await readFile(f.file, 'utf8')).toBe(f.encoded);
    expect(await readFile(original, 'utf8')).toBe(f.encoded);
    expect(await readdir(f.directory)).toEqual([`${f.value.sha256}.json`]);
  });

  it('rejects a well-formed but mismatched digest before creating any receipt directory', async () => {
    const f = await fixture();
    const wrongDigest = { ...f.value, sha256: '0'.repeat(64) };
    expect(wrongDigest.sha256).not.toBe(f.value.sha256);
    await expect(recordLocalVerification(f.directory, wrongDigest)).rejects.toThrow('invalid verification receipt');
    expect(await readdir(f.root)).toEqual([]);
  });

  it('rejects body mutation under the original digest and preserves an already recorded receipt', async () => {
    const f = await fixture();
    await recordLocalVerification(f.directory, f.value);
    const before = await identity(f.file);
    const changed: VerificationReceipt = { ...f.value, request: { ...f.value.request, headSha: 'e'.repeat(40) } };
    await expect(recordLocalVerification(f.directory, changed)).rejects.toThrow('invalid verification receipt');
    expect(await identity(f.file)).toEqual(before);
    expect(await readFile(f.file, 'utf8')).toBe(f.encoded);
    expect(await readdir(f.directory)).toEqual([`${f.value.sha256}.json`]);
  });
});
