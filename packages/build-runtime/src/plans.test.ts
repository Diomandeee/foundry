import { describe, expect, it } from 'vitest';
import { approveRecipe, buildPlan, phasesFor, profileDigest } from './plans.js';
import type { Approval } from './types.js';

const image = `python@sha256:${'a'.repeat(64)}`;
const host = { uid: 1100, gid: 1100, dedicatedBuildUser: true as const, allowActivation: false,
  inputBase: '/var/lib/foundry-linux/input', workBase: '/var/lib/foundry-linux/work', journalRoot: '/var/lib/foundry-linux/journal',
  imageExecutables: { python: '/usr/local/bin/python3', npm: '/usr/local/bin/npm' } };
const limits = { cpu: 2, ramMib: 3072, pids: 512, timeoutMs: 900000, maxOutputBytes: 8388608, tmpMib: 512, minFreeBytes: 50 * 1024 ** 3 };
const attempt = { attemptId: 'a1', jobId: 'j1', inputRoot: '/var/lib/foundry-linux/input/a1', workRoot: '/var/lib/foundry-linux/work/a1' };
const python = (extra: Partial<Approval['recipe']> = {}): Approval => ({ host, limits, recipe: { kind: 'linux-build-v1', image, architecture: 'x64',
  tool: 'python', args: ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--junitxml=/work/out/junit.xml', '/work/source/calibrate_extrinsics'],
  network: 'none', outputPaths: ['out/junit.xml'], ...extra } as Approval['recipe'] });

describe('python linux recipes', () => {
  it('runs an owner-approved offline pip phase before the approved args', () => {
    const a = approveRecipe(python({ installArgs: ['--find-links', '/work/source/wheels', 'numpy', 'pytest'] } as never));
    const plan = buildPlan(a, attempt);
    expect(phasesFor(plan)).toEqual([
      ['/usr/local/bin/python3', '-m', 'pip', 'install', '--no-index', '--no-cache-dir', '--target', '/work/site', '--find-links', '/work/source/wheels', 'numpy', 'pytest'],
      ['/usr/local/bin/python3', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--junitxml=/work/out/junit.xml', '/work/source/calibrate_extrinsics'],
    ]);
    expect(plan.env).toMatchObject({ HOME: '/work', TMPDIR: '/tmp', PYTHONPATH: '/work/site:/work/source', PIP_NO_INDEX: '1', PIP_NO_CACHE_DIR: '1', PYTHONDONTWRITEBYTECODE: '1' });
    expect(plan.image).toBe(image);
  });
  it('is a single phase without installArgs, and the digest tells the two apart', () => {
    const plain = approveRecipe(python());
    const withInstall = approveRecipe(python({ installArgs: ['--find-links', '/work/source/wheels', 'numpy'] } as never));
    expect(phasesFor(buildPlan(plain, attempt))).toHaveLength(1);
    expect(profileDigest(plain)).not.toBe(profileDigest(withInstall));
    expect(profileDigest(plain)).toBe(profileDigest(approveRecipe(python())));
  });
  it('refuses installArgs on other tools, empty lists, control characters and a missing executable mapping', () => {
    expect(() => approveRecipe({ ...python(), recipe: { ...python().recipe, tool: 'npm', installArgs: ['x'] } as never })).toThrow('invalid-install-args');
    expect(() => approveRecipe(python({ installArgs: [] } as never))).toThrow('invalid-install-args');
    expect(() => approveRecipe(python({ installArgs: ['a\nb'] } as never))).toThrow('invalid-install-args');
    expect(() => approveRecipe({ ...python(), host: { ...host, imageExecutables: { npm: '/usr/local/bin/npm' } } })).toThrow('image-executable-mapping-required');
  });
});
